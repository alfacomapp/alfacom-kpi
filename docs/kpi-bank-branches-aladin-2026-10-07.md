# KPI: BRI Kendari, BRI Raha, dan Bank Aladin Syariah

Daftar bank laporan akun bank pekanan menjadi BRI Kendari (`bri_kendari`), BRI Raha (`bri_raha`), Mandiri (`mandiri`), Bank Sultra (`bank_sultra`), dan Bank Aladin Syariah (`aladin_syariah`). Dasar perubahan adalah frontend commit `148b78d` dan Edge `kpi-api` versi 11.

Laporan pekanan aktif dan baru selesai setelah **5/5 bank** dilaporkan. Backend memakai daftar yang sama untuk validasi, hitungan, dan label tugas. Tugas baru yang dibuat penjadwal menyimpan `requiredBankKeys`, termasuk sebelum laporan pertama. Laporan duplikat bank yang sama tetap ditolak.

BRI lama tidak dipetakan otomatis ke Kendari atau Raha. Data dan lampirannya tetap tersimpan sebagai riwayat `BRI (laporan lama)`. Tugas aktif memerlukan kedua cabang dan Aladin; Mandiri/Bank Sultra yang sudah dilaporkan tetap dihitung. Tugas lama yang sudah ditutup tetap memakai riwayat tiga bank dan tidak dibuka kembali. Tidak diperlukan migrasi database atau perubahan data produksi.

Foto/PDF tetap disimpan di bucket Supabase privat `kpi-uploads`. Grup lampiran mengikuti kode masing-masing bank, sehingga `bankStatement_bri_kendari`, `bankStatement_bri_raha`, dan `bankStatement_aladin_syariah` terpisah. Batas 50 file gabungan/10 MiB per laporan, kompresi, pratinjau/unduh PDF, serta notifikasi WA Notes dipertahankan.

Perubahan hanya pada frontend KPI, Edge KPI, dan tes KPI. Tidak ada perubahan frontend, API, tabel, trigger, atau penjadwal SLA. Cache frontend diperbarui menjadi `2026-10-07-bank-branches-aladin`.

Verifikasi: 22 tes KPI lulus, termasuk lima bank, lampiran setiap bank, duplikat BRI, riwayat BRI lama, tugas penjadwal, validasi upload, autentikasi, dan Notes WA. Uji Chrome memastikan lima pilihan bank, pengiriman payload BRI Kendari/BRI Raha/Aladin dengan foto dan PDF, reset form, dan tampilan ponsel tanpa overflow/error JavaScript. Pengujian browser memakai API tiruan; tidak membuat laporan uji atau mengirim WA ke pengguna produksi.

51 tes regresi SLA terkait absensi, hari kerja, profil Auth, dan rekening slip gaji lulus. Hash enam file utama SLA (`index.html`, `code.js`, `absen.html`, `codeabsensi.txt`, `slipgaji.html`, `sw.js`) identik sebelum/sesudah perubahan.
