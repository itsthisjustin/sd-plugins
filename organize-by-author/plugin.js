// File Manager plugin — sorts the EPUBs in the current folder into per-author
// subfolders. A worked example of a "files" plugin: it uses only the same-origin
// File Manager endpoints the page already exposes (/api/files, /mkdir, /move) and
// the JSZip library the page already loads, so it needs nothing from the device
// beyond what the browser can reach. Copy this folder to
// /.crosspoint/plugins/organize-by-author/ on the SD card.

CrossPoint.registerPlugin((container, api) => {
  // The File Manager keeps the folder it's viewing in the URL query.
  const folder = new URLSearchParams(window.location.search).get('path') || '/';
  const here = folder === '/' ? '' : folder.replace(/\/$/, '');
  const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  container.innerHTML =
    '<h2>Sort EPUBs by author</h2>' +
    '<p style="color:var(--label-color);font-size:0.9em;margin:0 0 12px;">' +
    'Reads each EPUB in <strong>' + escapeHtml(folder || '/') + '</strong>, then files it into a ' +
    'folder named for its author. Books whose author can\'t be read are left in place.</p>' +
    '<div style="text-align:center;"><button type="button" class="btn-small btn-add" id="org-go">Organize this folder</button></div>' +
    '<div id="org-status" style="margin-top:12px;color:var(--label-color);font-size:0.9em;white-space:pre-line;"></div>';

  const statusEl = document.getElementById('org-status');
  const status = (m) => { statusEl.textContent = m; };

  document.getElementById('org-go').onclick = async () => {
    const btn = document.getElementById('org-go');
    btn.disabled = true;
    try {
      await organize();
    } catch (e) {
      status('Error: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  };

  async function organize() {
    if (typeof JSZip === 'undefined') { status('JSZip is not available on this page.'); return; }

    status('Reading folder…');
    const listResponse = await fetch('/api/files?path=' + encodeURIComponent(folder || '/'));
    if (!listResponse.ok) throw new Error('could not read this folder (HTTP ' + listResponse.status + ')');
    const entries = await listResponse.json();
    const books = entries.filter((e) => !e.isDirectory && e.isEpub);
    if (!books.length) { status('No EPUBs to sort in this folder.'); return; }
    const names = new Set(entries.filter((e) => !e.isDirectory).map((e) => e.name));

    let moved = 0, skipped = 0, done = 0;
    for (const book of books) {
      done++;
      const src = here + '/' + book.name;
      status('Reading ' + done + '/' + books.length + ': ' + book.name);
      let author;
      try {
        author = await readAuthor(src);
      } catch (e) {
        author = '';
      }
      const folderName = sanitize(author);
      if (!folderName) { skipped++; continue; }

      // Don't move a book that already lives in its author folder.
      if (here.split('/').pop() === folderName) { skipped++; continue; }

      const dest = (here || '') + '/' + folderName;
      await ensureFolder(folderName);
      status('Filing ' + done + '/' + books.length + ': ' + book.name + ' → ' + folderName + '/');
      const bookMove = await move(src, dest);
      if (!bookMove.ok) {
        skipped++;
        continue;
      }

      // Protected EPUBs use a neighboring "<book>.epub.rights" file. Keep the
      // pair together when that sidecar is visible in the current listing.
      const rightsName = book.name + '.rights';
      if (names.has(rightsName)) {
        const rightsMove = await move(here + '/' + rightsName, dest);
        if (!rightsMove.ok) {
          // Best-effort rollback: an EPUB without its rights sidecar will not
          // open, so put the book back if the second half of the move fails.
          const rollback = await move(dest + '/' + book.name, here || '/');
          throw new Error('moved ' + book.name + ' but not its rights file (HTTP ' +
            rightsMove.status + ')' + (rollback.ok ? '; the book was put back' : '; rollback also failed'));
        }
      }
      moved++;
    }

    status('Done. Filed ' + moved + ', left ' + skipped + ' in place.\nReload the page to see the changes.');
  }

  // --- read the author out of an EPUB's OPF metadata ------------------------
  async function readAuthor(path) {
    const download = await fetch('/download?path=' + encodeURIComponent(path));
    if (!download.ok) throw new Error('download HTTP ' + download.status);
    const buf = await download.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);

    const containerFile = zip.file('META-INF/container.xml');
    if (!containerFile) return '';
    const container = await containerFile.async('string');
    const containerDoc = parseXml(container);
    const rootfile = firstByLocalName(containerDoc, 'rootfile');
    const rootPath = rootfile && rootfile.getAttribute('full-path');
    if (!rootPath) return '';

    const opfFile = zip.file(rootPath);
    if (!opfFile) return '';
    const opf = await opfFile.async('string');
    const opfDoc = parseXml(opf);
    const creator = firstByLocalName(opfDoc, 'creator');
    if (!creator) return '';

    // EPUB 2 stores file-as on dc:creator. EPUB 3 commonly stores it in a
    // refining <meta property="file-as" refines="#creator-id"> element.
    const directFileAs = creator.getAttribute('opf:file-as') || creator.getAttribute('file-as');
    if (directFileAs) return directFileAs;
    const creatorId = creator.getAttribute('id');
    if (creatorId) {
      const metas = Array.from(opfDoc.getElementsByTagNameNS('*', 'meta'));
      const refined = metas.find((meta) =>
        meta.getAttribute('property') === 'file-as' &&
        meta.getAttribute('refines') === '#' + creatorId);
      if (refined && refined.textContent.trim()) return refined.textContent.trim();
    }
    return creator.textContent.trim();
  }

  // --- helpers --------------------------------------------------------------
  function parseXml(source) {
    const doc = new DOMParser().parseFromString(source, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('invalid EPUB metadata XML');
    return doc;
  }

  function firstByLocalName(doc, name) {
    const matches = doc.getElementsByTagNameNS('*', name);
    return matches.length ? matches[0] : null;
  }

  function sanitize(name) {
    return (name || '')
      .replace(/[\/\\:*?"<>|]/g, ' ')    // characters not allowed in a folder name
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+|\.+$/g, '')
      .trim()
      .slice(0, 60);
  }

  async function ensureFolder(name) {
    const body = 'name=' + encodeURIComponent(name) + '&path=' + encodeURIComponent(folder || '/');
    const r = await fetch('/mkdir', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    // 400 "already exists" is fine; anything else that isn't ok is a real failure.
    if (!r.ok && r.status !== 400) throw new Error('mkdir ' + r.status);
  }

  async function move(src, dest) {
    const body = 'path=' + encodeURIComponent(src) + '&dest=' + encodeURIComponent(dest);
    const r = await fetch('/move', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    return { ok: r.ok, status: r.status };
  }
});
