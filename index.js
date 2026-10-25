import "dotenv/config";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const app = express();
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
const jwtSecret = process.env.JWT_SECRET;

if (!supabaseUrl || !supabaseSecretKey) {
  throw new Error(
    "SUPABASE_URL dan SUPABASE_SECRET_KEY wajib diatur."
  );
}

if (!jwtSecret) {
  throw new Error("JWT_SECRET wajib diatur.");
}

const supabase = createClient(supabaseUrl, supabaseSecretKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
});

const bookFields = `
  id,
  title,
  isbn,
  description,
  author_id,
  category_id,
  total_copies,
  available_copies,
  created_at,
  author:authors(id, name),
  category:categories(id, name)
`;

// ==================================================
// HELPER FUNCTIONS
// ==================================================

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sendDbError(res, error) {
  const debugInfo = {
    message: error?.message,
    code: error?.code,
    details: error?.details,
    hint: error?.hint,
  };

  console.error("Database error detail:", debugInfo);

  if (error?.code === "23505") {
    return res.status(409).json({
      error: "Data dengan nilai unik tersebut sudah ada.",
    });
  }

  if (error?.code === "23503") {
    return res.status(400).json({
      error:
        "Relasi tidak valid. Periksa ID penulis, kategori, atau data terkait.",
    });
  }

  if (
    error?.code === "23514" ||
    error?.code === "22P02"
  ) {
    return res.status(400).json({
      error: "Nilai yang dikirim tidak memenuhi aturan database.",
    });
  }

  const response = {
    error: "Terjadi kesalahan saat mengakses database.",
  };

  // Detail debugging hanya ditampilkan saat pengembangan lokal.
  if (process.env.NODE_ENV !== "production") {
    response.debug = debugInfo;
  }

  return res.status(500).json(response);
}

// ==================================================
// AUTHENTICATION MIDDLEWARE
// ==================================================

// Memastikan request memiliki JWT yang valid.
function requireAuth(req, res, next) {
  const authorization = req.headers.authorization || "";
  const [scheme, token] = authorization.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({
      error: "Login diperlukan untuk mengakses endpoint ini.",
    });
  }

  try {
    const payload = jwt.verify(token, jwtSecret);

    if (typeof payload === "string") {
      return res.status(401).json({
        error: "Token tidak valid.",
      });
    }

    const userId = Number(payload.sub);
    const role = payload.role;

    if (
      !Number.isSafeInteger(userId) ||
      userId <= 0 ||
      !["admin", "user"].includes(role)
    ) {
      return res.status(401).json({
        error: "Token tidak valid.",
      });
    }

    req.auth = {
      userId,
      role,
    };

    return next();
  } catch {
    return res.status(401).json({
      error: "Token tidak valid atau sudah kedaluwarsa.",
    });
  }
}

// Hanya mengizinkan pengguna dengan role admin.
function requireAdmin(req, res, next) {
  if (req.auth?.role !== "admin") {
    return res.status(403).json({
      error: "Fitur ini hanya dapat diakses oleh Admin.",
    });
  }

  return next();
}

// ==================================================
// GET: INFORMASI API
// ==================================================

app.get("/", (req, res) => {
  return res.status(200).json({
    message: "Library Management API berjalan.",
    endpoints: {
      books: "/api/books",
      bookDetail: "/api/books/:id",
      categories: "/api/categories",
      authors: "/api/authors",
      register: "/api/auth/register",
      login: "/api/auth/login",
    },
  });
});

// ==================================================
// BOOKS
// ==================================================

// GET: semua buku
app.get("/api/books", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("books")
      .select(bookFields)
      .order("id", { ascending: true });

    if (error) {
      return sendDbError(res, error);
    }

    return res.status(200).json({ data });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// GET: buku berdasarkan ID
app.get("/api/books/:id", async (req, res) => {
  const id = parseId(req.params.id);

  if (!id) {
    return res.status(400).json({
      error: "ID harus berupa bilangan bulat positif.",
    });
  }

  try {
    const { data, error } = await supabase
      .from("books")
      .select(bookFields)
      .eq("id", id)
      .maybeSingle();

    if (error) {
      return sendDbError(res, error);
    }

    if (!data) {
      return res.status(404).json({
        error: "Buku tidak ditemukan.",
      });
    }

    return res.status(200).json({ data });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// POST: tambah buku (khusus Admin)
app.post(
  "/api/books",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const body = req.body ?? {};

    const title =
      typeof body.title === "string"
        ? body.title.trim()
        : "";

    const authorId = Number(body.author_id);
    const categoryId = Number(body.category_id);
    const totalCopies = Number(body.total_copies);

    if (!title) {
      return res.status(400).json({
        error: "Field title wajib diisi.",
      });
    }

    if (
      !Number.isSafeInteger(authorId) ||
      authorId <= 0
    ) {
      return res.status(400).json({
        error: "author_id harus berupa ID penulis yang valid.",
      });
    }

    if (
      !Number.isSafeInteger(categoryId) ||
      categoryId <= 0
    ) {
      return res.status(400).json({
        error: "category_id harus berupa ID kategori yang valid.",
      });
    }

    if (
      !Number.isSafeInteger(totalCopies) ||
      totalCopies < 1
    ) {
      return res.status(400).json({
        error: "total_copies minimal bernilai 1.",
      });
    }

    const payload = {
      title,
      isbn:
        typeof body.isbn === "string" && body.isbn.trim()
          ? body.isbn.trim()
          : null,
      description:
        typeof body.description === "string"
          ? body.description.trim()
          : null,
      author_id: authorId,
      category_id: categoryId,
      total_copies: totalCopies,
      available_copies: totalCopies,
    };

    try {
      const { data, error } = await supabase
        .from("books")
        .insert(payload)
        .select(bookFields)
        .single();

      if (error) {
        return sendDbError(res, error);
      }

      return res.status(201).json({
        message: "Buku berhasil ditambahkan.",
        data,
      });
    } catch (error) {
      return sendDbError(res, error);
    }
  }
);

// PATCH: ubah sebagian data buku (khusus Admin)
app.patch(
  "/api/books/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const id = parseId(req.params.id);

    if (!id) {
      return res.status(400).json({
        error: "ID harus berupa bilangan bulat positif.",
      });
    }

    const body = req.body ?? {};

    try {
      const {
        data: current,
        error: readError,
      } = await supabase
        .from("books")
        .select("*")
        .eq("id", id)
        .maybeSingle();

      if (readError) {
        return sendDbError(res, readError);
      }

      if (!current) {
        return res.status(404).json({
          error: "Buku tidak ditemukan.",
        });
      }

      const updates = {};

      if ("title" in body) {
        if (
          typeof body.title !== "string" ||
          !body.title.trim()
        ) {
          return res.status(400).json({
            error: "title harus berupa teks yang tidak kosong.",
          });
        }

        updates.title = body.title.trim();
      }

      if ("isbn" in body) {
        if (
          body.isbn !== null &&
          typeof body.isbn !== "string"
        ) {
          return res.status(400).json({
            error: "isbn harus berupa teks atau null.",
          });
        }

        updates.isbn =
          typeof body.isbn === "string" && body.isbn.trim()
            ? body.isbn.trim()
            : null;
      }

      if ("description" in body) {
        if (
          body.description !== null &&
          typeof body.description !== "string"
        ) {
          return res.status(400).json({
            error: "description harus berupa teks atau null.",
          });
        }

        updates.description = body.description;
      }

      if ("author_id" in body) {
        const authorId = Number(body.author_id);

        if (
          !Number.isSafeInteger(authorId) ||
          authorId <= 0
        ) {
          return res.status(400).json({
            error: "author_id tidak valid.",
          });
        }

        updates.author_id = authorId;
      }

      if ("category_id" in body) {
        const categoryId = Number(body.category_id);

        if (
          !Number.isSafeInteger(categoryId) ||
          categoryId <= 0
        ) {
          return res.status(400).json({
            error: "category_id tidak valid.",
          });
        }

        updates.category_id = categoryId;
      }

      if ("total_copies" in body) {
        const totalCopies = Number(body.total_copies);

        if (
          !Number.isSafeInteger(totalCopies) ||
          totalCopies < 1
        ) {
          return res.status(400).json({
            error: "total_copies minimal bernilai 1.",
          });
        }

        const borrowedCount =
          current.total_copies -
          current.available_copies;

        const newAvailable =
          totalCopies - borrowedCount;

        if (newAvailable < 0) {
          return res.status(400).json({
            error:
              "Jumlah stok baru tidak boleh lebih kecil daripada jumlah buku yang sedang dipinjam.",
          });
        }

        updates.total_copies = totalCopies;
        updates.available_copies = newAvailable;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({
          error:
            "Kirim setidaknya satu field yang ingin diubah.",
        });
      }

      const { data, error } = await supabase
        .from("books")
        .update(updates)
        .eq("id", id)
        .select(bookFields)
        .single();

      if (error) {
        return sendDbError(res, error);
      }

      return res.status(200).json({
        message: "Buku berhasil diperbarui.",
        data,
      });
    } catch (error) {
      return sendDbError(res, error);
    }
  }
);

// DELETE: hapus buku (khusus Admin)
app.delete(
  "/api/books/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const id = parseId(req.params.id);

    if (!id) {
      return res.status(400).json({
        error: "ID harus berupa bilangan bulat positif.",
      });
    }

    try {
      const { data, error } = await supabase
        .from("books")
        .delete()
        .eq("id", id)
        .select("id")
        .maybeSingle();

      if (error) {
        if (error.code === "23503") {
          return res.status(409).json({
            error:
              "Buku tidak dapat dihapus karena masih memiliki relasi data peminjaman.",
          });
        }

        return sendDbError(res, error);
      }

      if (!data) {
        return res.status(404).json({
          error: "Buku tidak ditemukan.",
        });
      }

      return res.status(200).json({
        message: "Buku berhasil dihapus.",
      });
    } catch (error) {
      return sendDbError(res, error);
    }
  }
);

// ==================================================
// CATEGORIES
// ==================================================

// GET: seluruh kategori
app.get("/api/categories", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("categories")
      .select("id, name")
      .order("id", { ascending: true });

    if (error) {
      return sendDbError(res, error);
    }

    return res.status(200).json({ data });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ==================================================
// AUTHORS
// ==================================================

// GET: seluruh penulis
app.get("/api/authors", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("authors")
      .select("id, name")
      .order("id", { ascending: true });

    if (error) {
      return sendDbError(res, error);
    }

    return res.status(200).json({ data });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ==================================================
// AUTHENTICATION: REGISTER
// ==================================================

app.post("/api/auth/register", async (req, res) => {
  const body = req.body ?? {};

  const fullName =
    typeof body.full_name === "string"
      ? body.full_name.trim()
      : "";

  const email =
    typeof body.email === "string"
      ? body.email.trim().toLowerCase()
      : "";

  const password =
    typeof body.password === "string"
      ? body.password
      : "";

  // 1. Validasi input wajib
  if (!fullName || !email || !password) {
    return res.status(400).json({
      error: "Nama, email, dan password wajib diisi.",
    });
  }

  // 2. Validasi format email
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailPattern.test(email)) {
    return res.status(400).json({
      error: "Format email tidak valid.",
    });
  }

  // 3. Validasi panjang password
  if (password.length < 8) {
    return res.status(400).json({
      error: "Password minimal 8 karakter.",
    });
  }

  // Bcrypt memiliki batas 72 byte untuk password.
  if (Buffer.byteLength(password, "utf8") > 72) {
    return res.status(400).json({
      error: "Password tidak boleh melebihi 72 byte.",
    });
  }

  try {
    // 4. Cari role user.
    // Pengguna tidak boleh menentukan role_id sendiri.
    const { data: role, error: roleError } =
      await supabase
        .from("roles")
        .select("id")
        .eq("name", "user")
        .maybeSingle();

    if (roleError) {
      return sendDbError(res, roleError);
    }

    if (!role) {
      return res.status(500).json({
        error: "Role user belum tersedia di database.",
      });
    }

    // 5. Hash password sebelum disimpan
    const passwordHash = await bcrypt.hash(password, 12);

    // 6. Simpan pengguna baru
    const { data, error } = await supabase
      .from("users")
      .insert({
        full_name: fullName,
        email,
        password_hash: passwordHash,
        role_id: role.id,
      })
      .select("id, full_name, email, role_id")
      .single();

    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({
          error: "Email sudah terdaftar.",
        });
      }

      return sendDbError(res, error);
    }

    // 7. Respons tidak memuat password atau password_hash
    return res.status(201).json({
      message: "Registrasi berhasil.",
      data,
    });
  } catch (error) {
    console.error("Register error:", error);

    return res.status(500).json({
      error: "Terjadi kesalahan saat registrasi.",
    });
  }
});

// ==================================================
// AUTHENTICATION: LOGIN
// ==================================================

app.post("/api/auth/login", async (req, res) => {
  const body = req.body ?? {};

  const email =
    typeof body.email === "string"
      ? body.email.trim().toLowerCase()
      : "";

  const password =
    typeof body.password === "string"
      ? body.password
      : "";

  // 1. Validasi input wajib
  if (!email || !password) {
    return res.status(400).json({
      error: "Email dan password wajib diisi.",
    });
  }

  try {
    // 2. Cari pengguna berdasarkan email dan ambil role-nya
    const { data: user, error } = await supabase
      .from("users")
      .select(`
        id,
        full_name,
        email,
        password_hash,
        role_id,
        role:roles(name)
      `)
      .eq("email", email)
      .maybeSingle();

    if (error) {
      return sendDbError(res, error);
    }

    // 3. Email tidak ditemukan
    if (!user) {
      return res.status(401).json({
        error: "Email atau password salah.",
      });
    }

    // 4. Periksa password terhadap hash dalam database
    const passwordValid = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordValid) {
      return res.status(401).json({
        error: "Email atau password salah.",
      });
    }

    // 5. Pastikan role valid
    const roleName = user.role?.name;

    if (!["admin", "user"].includes(roleName)) {
      return res.status(500).json({
        error: "Role pengguna tidak valid.",
      });
    }

    // 6. Buat JWT yang berlaku selama dua jam
    const token = jwt.sign(
      { role: roleName },
      jwtSecret,
      {
        subject: String(user.id),
        expiresIn: "2h",
      }
    );

    // 7. Kirim token serta informasi akun yang aman
    return res.status(200).json({
      message: "Login berhasil.",
      token,
      data: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: roleName,
      },
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      error: "Terjadi kesalahan saat login.",
    });
  }
});

// ==================================================
// BORROWINGS: PINJAM BUKU
// ==================================================

app.post(
  "/api/borrowings",
  requireAuth,
  async (req, res) => {
    const bookId = parseId(req.body?.book_id);

    if (!bookId) {
      return res.status(400).json({
        error: "book_id harus berupa bilangan bulat positif.",
      });
    }

    try {
      const { data, error } = await supabase.rpc(
        "borrow_book",
        {
          p_user_id: req.auth.userId,
          p_book_id: bookId,
        }
      );

      if (error) {
        if (error.message.includes("BOOK_NOT_FOUND")) {
          return res.status(404).json({
            error: "Buku tidak ditemukan.",
          });
        }

        if (error.message.includes("BOOK_UNAVAILABLE")) {
          return res.status(409).json({
            error: "Buku tidak tersedia untuk dipinjam.",
          });
        }

        return sendDbError(res, error);
      }

      return res.status(201).json({
        message: "Buku berhasil dipinjam.",
        data,
      });
    } catch (error) {
      return sendDbError(res, error);
    }
  }
);

// ==================================================
// BORROWINGS: RIWAYAT PEMINJAMAN USER
// ==================================================

app.get(
  "/api/borrowings/me",
  requireAuth,
  async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("borrowings")
        .select(`
          id,
          borrowed_at,
          due_date,
          returned_at,
          status,
          book:books(
            id,
            title,
            isbn
          )
        `)
        .eq("user_id", req.auth.userId)
        .order("borrowed_at", {
          ascending: false,
        });

      if (error) {
        return sendDbError(res, error);
      }

      return res.status(200).json({
        data,
      });
    } catch (error) {
      return sendDbError(res, error);
    }
  }
);

// ==================================================
// BORROWINGS: KEMBALIKAN BUKU
// ==================================================

app.patch(
  "/api/borrowings/:id/return",
  requireAuth,
  async (req, res) => {
    const borrowingId = parseId(req.params.id);

    if (!borrowingId) {
      return res.status(400).json({
        error: "ID peminjaman tidak valid.",
      });
    }

    try {
      const { data, error } = await supabase.rpc(
        "return_borrowing",
        {
          p_user_id: req.auth.userId,
          p_borrowing_id: borrowingId,
        }
      );

      if (error) {
        if (
          error.message.includes("BORROWING_NOT_FOUND")
        ) {
          return res.status(404).json({
            error: "Data peminjaman tidak ditemukan.",
          });
        }

        if (error.message.includes("NOT_OWNER")) {
          return res.status(403).json({
            error:
              "Kamu tidak memiliki izin untuk mengembalikan peminjaman ini.",
          });
        }

        if (
          error.message.includes("ALREADY_RETURNED")
        ) {
          return res.status(409).json({
            error:
              "Peminjaman sudah selesai dikembalikan.",
          });
        }

        return sendDbError(res, error);
      }

      return res.status(200).json({
        message: "Buku berhasil dikembalikan.",
        data,
      });
    } catch (error) {
      return sendDbError(res, error);
    }
  }
);

// ==================================================
// ADMIN: SEMUA RIWAYAT PEMINJAMAN
// ==================================================

app.get(
  "/api/admin/borrowings",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("borrowings")
        .select(`
          id,
          borrowed_at,
          due_date,
          returned_at,
          status,
          user:users(
            id,
            full_name,
            email
          ),
          book:books(
            id,
            title,
            isbn
          )
        `)
        .order("borrowed_at", {
          ascending: false,
        });

      if (error) {
        return sendDbError(res, error);
      }

      return res.status(200).json({
        data,
      });
    } catch (error) {
      return sendDbError(res, error);
    }
  }
);

// ==================================================
// CRON: PENGEMBALIAN OTOMATIS
// ==================================================

app.get("/api/cron/auto-return", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return res.status(500).json({
      error: "CRON_SECRET belum dikonfigurasi.",
    });
  }

  if (
    req.headers.authorization !== `Bearer ${cronSecret}`
  ) {
    return res.status(401).json({
      error: "Tidak memiliki izin menjalankan tugas otomatis.",
    });
  }

  try {
    const { data, error } = await supabase.rpc(
      "auto_return_expired_borrowings"
    );

    if (error) {
      return sendDbError(res, error);
    }

    return res.status(200).json({
      message: "Pemeriksaan peminjaman kedaluwarsa selesai.",
      processed: data,
    });
  } catch (error) {
    return sendDbError(res, error);
  }
});

// ==================================================
// ERROR HANDLING
// ==================================================

// Menangani JSON yang rusak dan error tak terduga
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({
      error: "Format JSON tidak valid.",
    });
  }

  console.error(err);

  return res.status(500).json({
    error: "Terjadi kesalahan pada server.",
  });
});

// ==================================================
// SERVER
// ==================================================

const PORT = process.env.PORT || 3000;

// Vercel menangani Express sebagai function.
// Di lokal, server mendengarkan port 3000.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`API berjalan di http://localhost:${PORT}`);
  });
}

export default app;