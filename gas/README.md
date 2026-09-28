# KPI melalui Supabase Edge

Pengguna membuka `index.html` setelah login di Lobby SLA. Halaman mengirim JWT sesi SLA dan permintaan KPI langsung ke Edge Function `kpi-api` pada proyek Supabase `oozkqjgllubhjctnkxwl`. Fungsi tersebut memeriksa JWT melalui Supabase Auth, profil SLA, peran KPI, serta izin setiap aksi dan lampiran. Kunci rahasia Supabase tetap di server.

`gas/Kode.gs` hanya menjalankan `scheduledDailyCheck()`. Pemicu berbasis waktu yang sudah ada pada proyek Apps Script KPI menjalankannya sekitar pukul 07.00 WITA setiap hari. GAS mengirim permintaan `apiRunDailyMaintenance` ke Edge memakai Script Property `KPI_SUPABASE_SECRET_KEY`; fungsi Edge menolak origin browser dan kunci yang bukan kunci server. Jangan memasang pemicu kedua.

Aturan pembentukan tugas, laporan, status, dan akses pengguna berada di `supabase/functions/kpi-api/index.ts`. Data KPI berada di tabel `kpi_*`; kehadiran dibaca dari `public.absensi`, dan lampiran di bucket privat `kpi-uploads`. GAS tidak melayani permintaan halaman atau menyimpan data KPI.

Pastikan fungsi Edge terbit sebelum mengubah `index.html`, lalu verifikasi login, dashboard, laporan, lampiran, dan hasil pemicu di produksi.
