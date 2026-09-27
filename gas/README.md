# Arsitektur KPI: GAS sebagai otak, Supabase sebagai penyimpanan

## Alur produksi

1. Pengguna masuk di aplikasi SLA. Lobby SLA membuka GitHub Pages KPI dan menyerahkan JWT sesi melalui `postMessage` dengan nonce serta pemeriksaan origin.
2. `index.html` mengirim `{action,args}` ke Worker `https://alfacom-kpi.alfacomapp.workers.dev`. JWT SLA berada pada `args[0]`.
3. Worker menambahkan `SHARED_SECRET` dan meneruskan permintaan ke deployment Web App proyek GAS KPI. Worker hanya menangani CORS, HTTPS, dan penerusan; jangan pindahkan aturan KPI ke Worker.
4. `gas/Kode.gs` memverifikasi JWT di Supabase Auth, memeriksa profil di tabel SLA `users`, lalu mencocokkan peran dengan tabel `kpi_users`. GAS menjalankan seluruh aturan KPI, izin baca/tulis, formulir laporan, perhitungan tugas, dan trigger harian.
5. GAS membaca/menulis tabel `kpi_users`, `kpi_notes`, `kpi_reports`, `kpi_tasks`, dan `kpi_activity_logs` melalui Supabase REST. GAS membaca tabel SLA `absensi` untuk status/pause KPI; GAS KPI **tidak menulis** absensi.
6. Lampiran KPI masuk ke bucket privat `kpi-uploads` di Supabase Storage. GAS memeriksa izin sebelum mengembalikan file. Google Drive tidak dipakai untuk lampiran baru.

Supabase Edge Function `kpi-api` dari arsitektur sebelumnya boleh tetap tersedia untuk rollback, tetapi halaman KPI produksi tidak memanggilnya setelah pengalihan ini. Jangan menghapusnya sebelum jalur GAS teruji dan rencana rollback disepakati.

## Peran dari SLA

| Akun SLA | Peran KPI | Ruang lingkup |
| --- | --- | --- |
| Direktur | `owner` | Seluruh KPI |
| Manager | `auditor` | Sesuai aturan auditor KPI |
| Admin Kendari | `admin_kendari` | Kendari |
| Admin Raha | `admin_raha` | Raha |
| Sales bernama login `juna` di Kendari | `sales_director` | Sesuai aturan Sales Director KPI |

Peran lain ditolak. Setiap panggilan GAS memeriksa kembali JWT, profil SLA, dan kecocokan satu pengguna KPI yang aktif; jangan percaya pada peran yang dikirim browser. Tidak ada halaman login atau password KPI terpisah.

## Konfigurasi rahasia dan penerapan

- Proyek Apps Script KPI menyimpan `KPI_SUPABASE_SECRET_KEY` dan `SHARED_SECRET` dalam **Script Properties**. Jangan taruh nilainya di source, GitHub, atau browser.
- Worker menyimpan `GAS_URL`, `SHARED_SECRET`, dan `ALLOWED_ORIGIN=https://alfacomapp.github.io` sebagai environment variables/secrets. `GAS_URL` harus menunjuk deployment `/exec` GAS KPI yang aktif.
- Web App GAS dijalankan sebagai pemilik proyek dan dapat diakses Worker. Batasi seluruh tindakan melalui `SHARED_SECRET` dan pemeriksaan JWT/peran di `Kode.gs`.
- `gas/appsscript.json` menetapkan izin minimum untuk koneksi Supabase, trigger harian, dan menu pada spreadsheet aktif. Tidak ada izin Google Drive. Pemilik deployment harus menyetujui izin `script.external_request` sebelum Web App dapat membaca Supabase; tanpa izin ini login KPI ditolak walaupun eksekusi `doPost` terlihat selesai.
- Sesudah source GAS disimpan, terbitkan versi baru **pada deployment aktif yang sama** agar URL Worker tetap berlaku. Uji penolakan token tidak valid, lalu uji handoff dari lobby SLA, dashboard, laporan, dan lampiran dengan akun yang berhak.
- Pasang `installDailyTrigger()` satu kali. Trigger menjalankan `scheduledDailyCheck()` pukul 07.00 WITA dan membuat tugas berkala dari aturan GAS. Jangan pasang trigger lama yang memanggil Edge Function atau Sheet.
- Publikasikan `index.html` dengan `KPI_API_URL` mengarah ke Worker. Jangan kirim kunci rahasia Supabase ke halaman.

## Batasan dan pemeliharaan

- `setupSpreadsheet_()` adalah nama fungsi kompatibilitas dari kode lama. Implementasinya hanya mengecek koneksi tabel Supabase, tidak membaca atau membuat Google Sheet.
- Kolom `record` JSON di tabel `kpi_*` tetap mengikuti struktur field lama (`Id`, `TaskType`, `PayloadJson`, dan sebagainya). Ubah skema/aturan dengan migrasi yang diaudit; jangan langsung mengedit tabel SLA atau `absensi`.
- Status berjalan/pause/meleset pada tampilan dihitung dari tugas dan absensi saat dibaca. GAS tidak menulis ulang status turunan itu ke tugas, agar keputusan manual owner tidak tertimpa.
- Dashboard pertama kali memilih bulan berjalan menurut zona waktu proyek; filter bulan/tahun lama memilih periode itu. GAS menentukan pilihan periode dari tugas mentah, lalu menghitung status/timer hanya untuk tugas di bulan terpilih. Absensi untuk dashboard dibaca dari awal sampai sebelum awal bulan berikutnya. Trigger `scheduledDailyCheck()` tetap membentuk tugas harian; membuka dashboard bulan lama tidak menjalankan pembentukan tugas bulan berjalan.
- Perubahan satu record memakai pemeriksaan `revision`. Aksi yang menulis banyak record masih menggunakan beberapa operasi Supabase, sehingga jika satu langkah gagal, sebagian data bisa sudah tersimpan. Audit dan tangani kasus ini sebelum menambah alur multi-record baru.
- Lampiran maksimum 10 MB per file. File lama yang masih ber-ID Google Drive perlu dimigrasikan terpisah bila ada; jangan mengaktifkan kembali Drive di jalur baru.
- Respons pertama setelah cache dingin dapat lebih lambat karena GAS membaca Supabase dan absensi. Cache GAS berumur pendek; kebenaran data tetap berada di Supabase.

Pengujian lokal: `node --test gas/brain.test.cjs gas/dashboard-period.test.cjs`. Tes ini memeriksa otorisasi sesi SLA, pembatasan peran, update profil, unggah/unduh lampiran privat, dan pembatasan perhitungan dashboard ke periode terpilih tanpa mengubah data produksi.
