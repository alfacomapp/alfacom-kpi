(function (root) {
  'use strict';
  const MAX_FILES = 50;
  const MAX_BYTES = 10 * 1024 * 1024;
  const scriptUrl = typeof document !== 'undefined' && document.currentScript ? document.currentScript.src : '';
  let pdfLibrary;

  function totalBytes(files) {
    return files.reduce((sum, file) => sum + file.size, 0);
  }
  function isPdf(file) {
    return file.type === 'application/pdf' || ((!file.type || file.type === 'application/octet-stream') && /\.pdf$/i.test(file.name));
  }
  async function validate(entries) {
    if (entries.length > MAX_FILES) throw new Error('Lampiran maksimal 50 file per laporan.');
    for (const entry of entries) {
      const file = entry.file;
      if (!file.size) throw new Error(file.name + ' kosong.');
      if (entry.field === 'bankStatement' || isPdf(file)) {
        const header = new TextDecoder().decode(await file.slice(0, 5).arrayBuffer());
        if (!isPdf(file) || header !== '%PDF-') throw new Error(file.name + ' harus berupa PDF yang valid.');
      } else if (!/^image\//.test(file.type)) {
        throw new Error(file.name + ' harus berupa gambar atau PDF.');
      }
    }
  }
  function loadPdfLibrary() {
    if (root.PDFLib) return Promise.resolve(root.PDFLib);
    if (!pdfLibrary) {
      pdfLibrary = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = new URL('vendor/pdf-lib-1.17.1.min.js', scriptUrl).href;
        script.onload = () => root.PDFLib ? resolve(root.PDFLib) : reject(new Error('Pustaka kompresi PDF tidak tersedia.'));
        script.onerror = () => reject(new Error('Pustaka kompresi PDF gagal dimuat. Coba kembali.'));
        document.head.appendChild(script);
      }).catch(error => { pdfLibrary = null; throw error; });
    }
    return pdfLibrary;
  }
  function canvasBlob(canvas, quality) {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Kompresi gambar gagal.')), 'image/jpeg', quality));
  }
  async function compressImage(file, target) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      let best = file;
      for (const [edge, quality] of [[2400, 0.86], [2000, 0.76], [1600, 0.66], [1200, 0.62]]) {
        const ratio = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
        canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Kompresi gambar tidak didukung browser ini.');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await canvasBlob(canvas, quality);
        canvas.width = canvas.height = 0;
        if (blob.size < best.size) best = new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: file.lastModified });
        if (best.size <= target) break;
      }
      return best;
    } finally {
      bitmap.close();
    }
  }

  // Replace only supported embedded images. Keep pages, searchable text, fonts,
  // annotations and page content streams intact; never rasterize a statement.
  async function compressPdf(file, target) {
    const lib = await loadPdfLibrary();
    let pdf;
    try {
      pdf = await lib.PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false });
    } catch (_) {
      throw new Error(file.name + ' tidak dapat dikompresi. Gunakan PDF tanpa password yang valid.');
    }
    const key = lib.PDFName.of;
    const objects = pdf.context.enumerateIndirectObjects();
    if (objects.some(([, object]) => {
      const dict = object instanceof lib.PDFDict ? object : object.dict;
      return dict && (dict.get(key('ByteRange')) || String(dict.get(key('Type'))) === '/Sig' || String(dict.get(key('FT'))) === '/Sig');
    })) throw new Error(file.name + ' memiliki tanda tangan digital. Unggah versi asli yang lebih kecil agar tanda tangan tetap valid.');
    let best = file;
    for (const [edge, quality] of [[2400, 0.86], [2000, 0.76], [1600, 0.66]]) {
      for (const [ref, object] of objects) {
        if (!(object instanceof lib.PDFRawStream)) continue;
        const dict = object.dict;
        if (String(dict.get(key('Subtype'))) !== '/Image' || dict.has(key('SMask')) || dict.has(key('Mask')) || dict.has(key('Decode')) || dict.has(key('ImageMask'))) continue;
        const width = dict.lookup(key('Width'));
        const height = dict.lookup(key('Height'));
        const bits = dict.lookup(key('BitsPerComponent'));
        const color = String(dict.lookup(key('ColorSpace')));
        if (!(width instanceof lib.PDFNumber) || !(height instanceof lib.PDFNumber) || !(bits instanceof lib.PDFNumber) || bits.asNumber() !== 8 || !['/DeviceRGB', '/DeviceGray'].includes(color)) continue;
        const filter = String(dict.get(key('Filter')));
        let bitmap;
        try {
          if (filter === '/DCTDecode') {
            bitmap = await createImageBitmap(new Blob([object.contents], { type: 'image/jpeg' }));
          } else if ((filter === '/FlateDecode' || !dict.has(key('Filter'))) && !dict.has(key('DecodeParms'))) {
            const w = width.asNumber(), h = height.asNumber(), channels = color === '/DeviceRGB' ? 3 : 1;
            if (w * h > 16000000) continue;
            const pixels = lib.decodePDFRawStream(object).decode();
            if (pixels.length !== w * h * channels) continue;
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const context = canvas.getContext('2d');
            const image = context.createImageData(w, h);
            for (let i = 0; i < w * h; i++) {
              image.data[i * 4] = pixels[i * channels];
              image.data[i * 4 + 1] = pixels[i * channels + (channels === 3 ? 1 : 0)];
              image.data[i * 4 + 2] = pixels[i * channels + (channels === 3 ? 2 : 0)];
              image.data[i * 4 + 3] = 255;
            }
            context.putImageData(image, 0, 0);
            bitmap = await createImageBitmap(canvas);
            canvas.width = canvas.height = 0;
          } else continue;
          const ratio = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
          canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
          canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          const compressed = await canvasBlob(canvas, quality);
          if (compressed.size < object.contents.length) {
            const replacement = dict.clone(pdf.context);
            replacement.set(key('Filter'), key('DCTDecode'));
            replacement.set(key('ColorSpace'), key('DeviceRGB'));
            replacement.set(key('Width'), lib.PDFNumber.of(canvas.width));
            replacement.set(key('Height'), lib.PDFNumber.of(canvas.height));
            replacement.delete(key('DecodeParms'));
            pdf.context.assign(ref, lib.PDFRawStream.of(replacement, new Uint8Array(await compressed.arrayBuffer())));
          }
          canvas.width = canvas.height = 0;
        } catch (_) {
          // Unsupported image encodings stay byte-for-byte intact.
        } finally {
          if (bitmap) bitmap.close();
        }
      }
      const bytes = await pdf.save({ useObjectStreams: true, updateFieldAppearances: false });
      if (bytes.length < best.size) best = new File([bytes], file.name, { type: 'application/pdf', lastModified: file.lastModified });
      if (best.size <= target) break;
    }
    return best;
  }
  async function prepare(entries, progress) {
    entries = entries.map(entry => isPdf(entry.file) && entry.file.type !== 'application/pdf'
      ? { field: entry.field, file: new File([entry.file], entry.file.name, { type: 'application/pdf', lastModified: entry.file.lastModified }) }
      : entry);
    await validate(entries);
    const originalBytes = totalBytes(entries.map(entry => entry.file));
    if (originalBytes <= MAX_BYTES) return { entries, originalBytes, bytes: originalBytes, compressed: 0 };
    const ratio = MAX_BYTES * 0.9 / originalBytes;
    const prepared = [];
    let remainingBytes = originalBytes;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (remainingBytes <= MAX_BYTES) {
        prepared.push(...entries.slice(i));
        break;
      }
      if (progress) progress('Mengompresi file ' + (i + 1) + '/' + entries.length + ': ' + entry.file.name);
      const target = Math.max(64 * 1024, Math.floor(entry.file.size * ratio));
      const file = entry.file.size <= target ? entry.file : isPdf(entry.file) ? await compressPdf(entry.file, target) : await compressImage(entry.file, target);
      prepared.push({ field: entry.field, file });
      remainingBytes += file.size - entry.file.size;
    }
    const bytes = totalBytes(prepared.map(entry => entry.file));
    if (bytes > MAX_BYTES) throw new Error('Total file setelah kompresi masih ' + (bytes / 1048576).toFixed(2) + ' MB. Kurangi lampiran atau gunakan file lebih kecil; maksimal 10 MB per laporan.');
    return { entries: prepared, originalBytes, bytes, compressed: prepared.filter((entry, i) => entry.file !== entries[i].file).length };
  }
  root.KpiBankUpload = { MAX_FILES, MAX_BYTES, prepare, validate, compressPdf, compressImage };
})(typeof window !== 'undefined' ? window : globalThis);
