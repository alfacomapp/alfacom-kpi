# KPI Pendapatan Harian: unggahan banyak foto

Permintaan akhir pengguna: foto uang fisik dan keadaan kas menerima banyak foto; unggahan nota menggunakan alur bukti akun bank pekanan, dengan **maksimal 10 file nota**.

## Perilaku

- Foto uang fisik, foto kas aplikasi kasir, dan nota: masing-masing maksimal 10 file. Nota juga menerima PDF seperti bukti akun bank. Bukti storan bank Raha tetap satu file.
- Total seluruh lampiran Pendapatan Harian dibatasi 10 MiB setelah kompresi, bukan 10 MiB per file atau per bagian. Form menampilkan batas tersebut.
- Modul kompresi yang sudah digunakan laporan akun bank menyiapkan semua lampiran sebelum dikirim. Gambar besar dikompresi; PDF memakai mekanisme yang sama tanpa merasterisasi halaman atau membuang teks.
- Foto dapat dipilih sekaligus atau ditambahkan melalui beberapa pemilihan file/kamera. Pilihan berikutnya menambah lampiran. Penambahan yang melebihi batas mempertahankan pilihan sebelumnya. Reset dan pengiriman berhasil membersihkan pilihan.
- Pratinjau dan unduh tersedia sebelum pengiriman. Penyimpanan tetap melalui `kpi-api` ke bucket Supabase privat `kpi-uploads`; referensi semua file disimpan pada laporan dan tugas. Pembacaan setelah unggah tetap memeriksa hak akses.
- Server memeriksa jumlah per bagian, ukuran biner gabungan, MIME, PDF dan format base64; ukuran deklaratif dari browser tidak dapat melewati batas.
- Laporan akun bank pekanan tetap maksimal 50 file dan 10 MiB total; pilihan BRI Kendari, BRI Raha dan Bank Aladin Syariah dipertahankan. Notifikasi WA tidak diubah.

## Verifikasi

- 8 pengujian baru `tests/daily-report-upload.test.cjs`: penyimpanan banyak file dan PDF, referensi tugas/laporan, akses file, batas 10/11, 10 MiB total tepat dan lebih satu byte, bukti storan Raha, lampiran wajib, penolakan data tidak valid, serta POST seluruh objek ke Supabase Storage dengan ID unik.
- 19 pengujian bank dan WA sebelumnya lulus. Pengujian handler, engine, dan scheduler juga lulus.
- Chrome desktop dan mobile dengan API tiruan yang menjalankan engine KPI: 11 lampiran dalam satu laporan dipertahankan; nota 10 file diterima dan tambahan ke-11 ditolak; foto PNG 14.431.314 byte dikompresi sehingga total seluruh lampiran menjadi 3.093.535 byte; pratinjau serta unduh JPEG berhasil; reset tidak membawa file laporan sebelumnya; tidak ada error JavaScript atau overflow mobile.
- Query Supabase memastikan bucket `kpi-uploads` masih privat. Tidak ada perubahan skema, RLS, data laporan pengguna, atau file aplikasi SLA.

Cadangan sebelum perubahan dan hasil uji browser disimpan di `tmp/kpi-daily-multi-photo-2026-10-07/` pada workspace pemeliharaan. Pengujian unggahan memakai data tiruan, tanpa mengirim laporan pengguna atau WA nyata.

## Rilis

Backend `kpi-api` versi 13 aktif di proyek `oozkqjgllubhjctnkxwl`; autentikasi khusus SLA tetap digunakan. Cache frontend: `2026-10-07-daily-multi-photo`, aset kompresi `2026-10-07-3`. Tidak ada deployment aplikasi SLA.
