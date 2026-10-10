# Akses User Raha untuk Alif dan Admin Raha

Login SLA `alif` dengan role `teknisi` dan login Admin Raha memakai akun KPI User Raha yang sudah ada. Keduanya memperoleh peran KPI `admin_raha`, lokasi `raha`, beserta menu, izin laporan, profil, tugas dan riwayat akun yang sama. Tidak dibuat akun KPI tambahan.

Pengecualian Alif memakai login tersimpan, bukan nama tampilan. Handler memverifikasi token melalui Supabase Auth, mencocokkan identitas token, lalu membaca login dan role dari tabel profil SLA pada setiap permintaan. Parameter browser dan `user_metadata` tidak menentukan hak akses. Teknisi lain, identitas tidak sesuai, sesi kedaluwarsa, serta akun KPI tidak aktif atau ambigu tetap ditolak.

Perubahan ini hanya memetakan akses KPI. Role, cabang, tiket, poin dan absensi SLA Alif mengikuti akun SLA yang sudah ada. Penerima notifikasi tugas WhatsApp mengikuti pemetaan sebelumnya.

Backend `supabase/functions/kpi-api/index.ts` menambahkan kondisi Alif pada `peranKpiDariSla_` dan `verifyIdentity`. Sumber memakai baseline produksi commit `b33e3a8e8b44187f5af5a745345dc0a2bde6b108`; Edge Function `kpi-api` yang aktif adalah versi 19.

Jalankan pengujian mandiri dari root repositori:

```sh
node --test tests/alif-raha-access.test.cjs
```

Enam tes memeriksa kesamaan akun dan izin Alif/Admin Raha, penyimpanan catatan, pembatasan laporan, penolakan teknisi atau role lain, validasi identitas/token, serta akun tidak aktif atau ambigu. Tes memakai data contoh dan tidak mengakses database produksi. Verifikasi gabungan aplikasi SLA dan KPI sebelumnya meluluskan 36 tes serta tiga alur browser dengan data contoh.
