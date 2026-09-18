/* ============================================================
   SAHA ANKET SİSTEMİ — Frontend mantığı
   Google Identity Services ile giriş yapar, tüm veri işlemlerini
   Apps Script Web App API'sine (config.js -> API_URL) POST eder.
   ============================================================ */

const API_URL = window.APP_CONFIG.API_URL;
const CLIENT_ID = window.APP_CONFIG.GOOGLE_CLIENT_ID;

let session = null;           // {email, role, adSoyad, idToken}
let anketorTab = 'liste';     // 'liste' | 'ikinci' | 'profil'
let adminTab = 'yukle';       // 'yukle' | 'anketorler' | 'kisiler' | 'kvkk' | 'analiz'
let pendingKisiId = null;
let pendingSonuc = null;
let pendingKvkkBolge = null;
let parsedExcelRows = [];
let ilkListeCache = [];
let anketorBolgeler = [];

// ---------------------------------------------------------------
// API
// ---------------------------------------------------------------
async function api(action, payload) {
  payload = payload || {};
  if (session && session.idToken) payload.idToken = session.idToken;
  // text/plain kullanılıyor: Apps Script'e tarayıcıdan preflight'sız istek
  // atabilmek için standart bir yöntemdir.
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, payload })
  });
  const data = await res.json();
  if (!data.ok) {
    if (data.error === 'AUTH_FAILED') {
      doLogout();
    }
    throw new Error(data.message || data.error || 'Bilinmeyen hata');
  }
  return data;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2600);
}

// ---------------------------------------------------------------
// GOOGLE GİRİŞİ
// ---------------------------------------------------------------
window.onload = () => {
  const saved = sessionStorage.getItem('saha_session');
  if (saved) {
    session = JSON.parse(saved);
    enterApp();
    return;
  }
  initGoogleSignIn();
};

function initGoogleSignIn() {
  if (!window.google || !CLIENT_ID || CLIENT_ID.indexOf('BURAYA') === 0) {
    document.getElementById('loginError').textContent =
      'Google giriş yapılandırılmamış. config.js dosyasındaki GOOGLE_CLIENT_ID değerini ayarlayın.';
    document.getElementById('loginError').classList.remove('hidden');
    return;
  }
  google.accounts.id.initialize({
    client_id: CLIENT_ID,
    callback: onGoogleCredential
  });
  google.accounts.id.renderButton(document.getElementById('googleSignInBtn'), {
    theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', locale: 'tr'
  });
}

async function onGoogleCredential(resp) {
  const idToken = resp.credential;
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'auth', payload: { idToken } })
    });
    const data = await res.json();
    if (!data.ok) {
      document.getElementById('loginError').textContent = data.message || 'Giriş başarısız.';
      document.getElementById('loginError').classList.remove('hidden');
      return;
    }
    session = Object.assign({}, data.session, { idToken });
    sessionStorage.setItem('saha_session', JSON.stringify(session));
    enterApp();
  } catch (err) {
    document.getElementById('loginError').textContent = 'Bağlantı hatası: ' + err.message;
    document.getElementById('loginError').classList.remove('hidden');
  }
}

function doLogout() {
  sessionStorage.removeItem('saha_session');
  session = null;
  document.getElementById('app').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
  if (window.google) { try { google.accounts.id.disableAutoSelect(); } catch (e) {} }
}
document.getElementById('logoutBtn').addEventListener('click', doLogout);

// ---------------------------------------------------------------
// UYGULAMAYA GİRİŞ
// ---------------------------------------------------------------
function enterApp() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('whoName').textContent = session.adSoyad;
  document.getElementById('whoRole').textContent = session.role === 'admin' ? 'Yönetici' : 'Anketör';

  if (session.role === 'anketor') {
    document.getElementById('bottomNav').classList.remove('hidden');
    document.querySelectorAll('.nav-btn').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        anketorTab = b.dataset.tab;
        renderAnketor();
      });
    });
    renderAnketor();
  } else {
    document.getElementById('bottomNav').classList.add('hidden');
    renderAdmin();
  }
}

// =================================================================
// ANKETÖR AKIŞI
// =================================================================
async function renderAnketor() {
  const main = document.getElementById('mainContent');
  if (anketorTab === 'profil') {
    main.innerHTML = `
      <h1>Profil</h1>
      <p class="lede">Hesap bilgileriniz</p>
      <div class="card">
        <div style="margin-bottom:10px;"><b>Ad Soyad:</b> ${esc(session.adSoyad)}</div>
        <div><b>E-posta:</b> ${esc(session.email)}</div>
      </div>`;
    return;
  }

  if (anketorTab === 'sonuclarim') {
    main.innerHTML = `<h1>Sonuçlarım</h1>
      <p class="lede">Görüştüğünüz kişileri sonuca göre inceleyin; sonucu veya notunuzu güncelleyebilirsiniz.</p>
      <div class="choice-row choice-row-4" id="sonuclarimFilterRow">
        <button class="choice-btn sel-olumlu" data-f="olumlu">Olumlu</button>
        <button class="choice-btn sel-olumsuz" data-f="olumsuz">Olumsuz</button>
        <button class="choice-btn sel-kararsiz" data-f="kararsiz">Kararsız</button>
        <button class="choice-btn sel-oykullanamaz" data-f="oykullanamaz">Oy Kullanamayacak</button>
      </div>
      <div style="display:flex; gap:8px; margin:14px 0;">
        <input type="text" id="sonuclarimAramaInput" placeholder="İsimle ara (en az 3 harf)…" style="flex:1;">
      </div>
      <button class="btn btn-outline btn-block" id="sonuclarimPdfBtn" style="margin-bottom:14px;">📄 PDF İndir</button>
      <div id="listArea"><p class="lede">Yükleniyor…</p></div>`;

    document.querySelectorAll('#sonuclarimFilterRow .choice-btn').forEach(b => {
      if (b.dataset.f === sonuclarimFilter) b.classList.add('selected');
      b.addEventListener('click', () => {
        sonuclarimFilter = b.dataset.f;
        document.querySelectorAll('#sonuclarimFilterRow .choice-btn').forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
        loadSonuclarim();
      });
    });
    document.getElementById('sonuclarimAramaInput').addEventListener('input', (e) => {
      sonuclarimArama = e.target.value.trim();
      renderSonuclarimList();
    });
    document.getElementById('sonuclarimPdfBtn').addEventListener('click', () => {
      exportListToPDF('Sonuçlarım — ' + sonucEtiket(sonuclarimFilter), currentSonuclarimFiltered().map(k => ({
        isim: k.adSoyad, telefon: formatPhoneTR(k.telefon).display, not: k.ilkNotlar || ''
      })));
    });
    await loadSonuclarim();
    return;
  }

  if (anketorTab === 'isler') {
    main.innerHTML = `<h1>İş Listem</h1>
      <p class="lede">Yöneticinizin size atadığı işler.</p>
      <div id="listArea"><p class="lede">Yükleniyor…</p></div>`;
    try {
      const data = await api('getIsListem', {});
      renderIsListem(data.list);
    } catch (err) {
      document.getElementById('listArea').innerHTML = emptyState('⚠️', err.message);
    }
    return;
  }

  const isSecond = anketorTab === 'ikinci';
  main.innerHTML = isSecond
    ? `<h1>Sandığa Gidildi Oy Kullandı</h1>
       <p class="lede">İlk görüşmede olumlu bulunan (veya yönetici tarafından olumluya çevrilen) kişiler. 26 Eylül'den itibaren sandığa gidip gitmediklerini işaretleyebilirsiniz.</p>
       <div id="listArea"><p class="lede">Yükleniyor…</p></div>`
    : `<h1>İlk Görüşme Listem</h1>
       <p class="lede">Size atanan, henüz görüşülmemiş kişiler.</p>
       <div style="display:flex; gap:8px; margin-bottom:10px;">
         <input type="text" id="ilkAramaInput" placeholder="İsimle ara (en az 3 harf)…" style="flex:1;">
         <button class="btn btn-outline" id="yeniKisiBtn" style="white-space:nowrap;">+ Kişi Ekle</button>
       </div>
       <button class="btn btn-outline btn-block" id="ilkPdfBtn" style="margin-bottom:14px;">📄 PDF İndir</button>
       <div id="listArea"><p class="lede">Yükleniyor…</p></div>`;

  if (!isSecond) {
    document.getElementById('yeniKisiBtn').addEventListener('click', openYeniKisiModal);
    document.getElementById('ilkPdfBtn').addEventListener('click', () => {
      exportListToPDF('Henüz Görüşülmemiş Kişiler', currentIlkFiltered().map(k => ({
        isim: k.adSoyad, telefon: formatPhoneTR(k.telefon).display, not: ''
      })));
    });
  }

  try {
    const data = await api(isSecond ? 'getSecondList' : 'getMyList', {});
    if (data.kvkkRequired) {
      openKvkkModal(data.kvkkRequired);
      document.getElementById('listArea').innerHTML = emptyState('🔒', 'Bu listeyi görmeden önce KVKK onayı vermeniz gerekiyor.');
      return;
    }
    if (isSecond) {
      renderSandikList(data.list, data.sandikAktif);
    } else {
      ilkListeCache = data.list;
      anketorBolgeler = data.bolgeler || [];
      renderKisiList(ilkListeCache);
      const aramaInput = document.getElementById('ilkAramaInput');
      aramaInput.addEventListener('input', () => {
        const q = aramaInput.value.trim();
        const filtered = currentIlkFiltered();
        renderKisiList(filtered, q.length >= 3 ? 'Aramanızla eşleşen kişi bulunamadı.' : undefined);
      });
    }
  } catch (err) {
    document.getElementById('listArea').innerHTML = emptyState('⚠️', err.message);
  }
}

function normalizeTR(s) {
  return String(s || '').toLocaleLowerCase('tr-TR');
}

function currentIlkFiltered() {
  const input = document.getElementById('ilkAramaInput');
  const q = input ? input.value.trim() : '';
  if (q.length >= 3) {
    const qn = normalizeTR(q);
    return ilkListeCache.filter(k => normalizeTR(k.adSoyad).includes(qn));
  }
  return ilkListeCache;
}

// Tarayıcının "Yazdır / PDF olarak kaydet" özelliğini kullanarak, ek bir
// kütüphaneye gerek olmadan Türkçe karakterleri sorunsuz destekleyen bir
// PDF çıktısı üretir.
function exportListToPDF(title, rows) {
  const win = window.open('', '_blank');
  if (!win) {
    showToast('Yazdırma penceresi açılamadı. Pop-up engelleyiciyi kontrol edin.');
    return;
  }
  const rowsHtml = rows.map(r => `
    <tr>
      <td>${esc(r.isim)}</td>
      <td>${esc(r.telefon || '')}</td>
      <td>${esc(r.not || '')}</td>
    </tr>`).join('');
  win.document.write(`
    <!DOCTYPE html><html lang="tr"><head><meta charset="utf-8">
    <title>${esc(title)}</title>
    <style>
      body { font-family: -apple-system, system-ui, sans-serif; padding: 24px; color:#1c2521; }
      h1 { font-size: 18px; margin-bottom: 4px; }
      .tarih { font-size: 12px; color:#666; margin-bottom: 18px; }
      table { width:100%; border-collapse: collapse; font-size: 12.5px; }
      th, td { border: 1px solid #ccc; padding: 6px 8px; text-align:left; vertical-align: top; }
      th { background: #f0f0f0; }
      @media print { body { padding: 10px; } }
    </style>
    </head><body>
    <h1>${esc(title)}</h1>
    <div class="tarih">${new Date().toLocaleString('tr-TR')} — ${rows.length} kişi</div>
    <table><thead><tr><th>İsim</th><th>Telefon</th><th>Görüşme Notu</th></tr></thead>
    <tbody>${rowsHtml}</tbody></table>
    </body></html>
  `);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}

function emptyState(icon, text) {
  return `<div class="empty-state"><div class="big">${icon}</div>${esc(text)}</div>`;
}

function renderKisiList(list, emptyMsg) {
  const area = document.getElementById('listArea');
  if (!list.length) {
    area.innerHTML = emptyState('✅', emptyMsg || 'Şu anda görüşülecek yeni kişi yok.');
    return;
  }
  area.innerHTML = list.map(k => `
    <div class="card kisi-card" data-id="${k.id}">
      <div class="row1">
        <div class="ad">${esc(k.adSoyad)}</div>
        <div class="bolge">${esc(k.bolge)}</div>
      </div>
      <div class="adres">${esc(k.adres || '')}${k.ilce ? ', ' + esc(k.ilce) : ''}</div>
      <div class="meta">
        ${k.telefon ? `<span>📞 ${esc(k.telefon)}</span>` : ''}
        ${k.yas ? `<span>${esc(String(k.yas))} yaş</span>` : ''}
        ${k.cinsiyet ? `<span>${esc(k.cinsiyet)}</span>` : ''}
      </div>
    </div>
  `).join('');
  area.querySelectorAll('.kisi-card').forEach(el => {
    el.addEventListener('click', () => openInterviewModal(el.dataset.id, list));
  });
}

// ---- Sonuçlarım (anketörün kendi görüştüğü kişiler, düzenlenebilir) ----
let sonuclarimFilter = 'kararsiz';
let sonuclarimCache = [];
let sonuclarimArama = '';

async function loadSonuclarim() {
  document.getElementById('listArea').innerHTML = '<p class="lede">Yükleniyor…</p>';
  try {
    const data = await api('getSonuclarim', { sonucFiltre: sonuclarimFilter });
    if (data.kvkkRequired) {
      openKvkkModal(data.kvkkRequired);
      document.getElementById('listArea').innerHTML = emptyState('🔒', 'Bu listeyi görmeden önce KVKK onayı vermeniz gerekiyor.');
      return;
    }
    sonuclarimCache = data.list;
    renderSonuclarimList();
  } catch (err) {
    document.getElementById('listArea').innerHTML = emptyState('⚠️', err.message);
  }
}

function currentSonuclarimFiltered() {
  if (sonuclarimArama.length >= 3) {
    const q = normalizeTR(sonuclarimArama);
    return sonuclarimCache.filter(k => normalizeTR(k.adSoyad).includes(q));
  }
  return sonuclarimCache;
}

function sonucEtiket(f) {
  return f === 'olumlu' ? 'Olumlu' : f === 'olumsuz' ? 'Olumsuz' : 'Kararsız';
}

function renderSonuclarimList() {
  const area = document.getElementById('listArea');
  const list = currentSonuclarimFiltered();

  if (!list.length) {
    area.innerHTML = emptyState('📭', sonuclarimArama.length >= 3
      ? 'Aramanızla eşleşen kişi bulunamadı.'
      : 'Bu filtrede kimse yok.');
    return;
  }
  area.innerHTML = list.map(k => {
    const phone = formatPhoneTR(k.telefon);
    return `
    <div class="card kisi-row" data-id="${k.id}">
      <div class="kisi-row-header">
        <div class="row1">
          <div class="ad">${esc(k.adSoyad)}</div>
          ${phone.tel
            ? `<a class="tel-link" href="tel:${esc(phone.tel)}">${esc(phone.display)}</a>`
            : `<span class="tel-link tel-missing">${esc(phone.display)}</span>`}
        </div>
      </div>
      <div class="notes-area hidden">
        ${k.yoneticiNotu ? `<div class="field-help" style="margin-bottom:6px;">Yönetici notu</div><div style="margin-bottom:14px;">${esc(k.yoneticiNotu)}</div>` : ''}

        <label style="margin-top:0;">Sonucu Değiştir</label>
        <div class="choice-row edit-sonuc-row choice-row-4">
          <button class="choice-btn sel-olumlu${k.ilkSonuc === 'olumlu' ? ' selected' : ''}" data-val="olumlu">Olumlu</button>
          <button class="choice-btn sel-olumsuz${k.ilkSonuc === 'olumsuz' ? ' selected' : ''}" data-val="olumsuz">Olumsuz</button>
          <button class="choice-btn sel-kararsiz${k.ilkSonuc === 'kararsiz' ? ' selected' : ''}" data-val="kararsiz">Kararsız</button>
          <button class="choice-btn sel-oykullanamaz${k.ilkSonuc === 'oykullanamaz' ? ' selected' : ''}" data-val="oykullanamaz">Oy Kullanamayacak</button>
        </div>

        <label for="sn-${k.id}">Notunuz</label>
        <textarea id="sn-${k.id}" placeholder="Görüşme notunuzu güncelleyin">${esc(k.ilkNotlar || '')}</textarea>

        <button class="btn btn-primary edit-save-btn" style="margin-top:10px;">Kaydet</button>
      </div>
    </div>`;
  }).join('');

  area.querySelectorAll('.kisi-row-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.classList.contains('tel-link')) return;
      header.closest('.kisi-row').querySelector('.notes-area').classList.toggle('hidden');
    });
  });

  area.querySelectorAll('.kisi-row').forEach(card => {
    const id = card.dataset.id;
    const sonucRow = card.querySelector('.edit-sonuc-row');
    let secilen = (sonuclarimCache.find(k => String(k.id) === id) || {}).ilkSonuc;

    sonucRow.querySelectorAll('.choice-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        sonucRow.querySelectorAll('.choice-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        secilen = btn.dataset.val;
      });
    });

    card.querySelector('.edit-save-btn').addEventListener('click', async (evt) => {
      const btn = evt.currentTarget;
      const textarea = card.querySelector('textarea');
      btn.disabled = true; btn.textContent = 'Kaydediliyor…';
      try {
        await api('anketorUpdateKisi', { kisiId: id, yeniSonuc: secilen, kendiNotu: textarea.value });
        showToast('Kaydedildi.');
        loadSonuclarim(); // sonuç değiştiyse bu filtreden düşebilir, listeyi tazele
      } catch (err) {
        showToast('Hata: ' + err.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Kaydet';
      }
    });
  });
}

// ---- İş Listem (anketör) ----
function renderIsListem(list) {
  const area = document.getElementById('listArea');
  if (!list.length) {
    area.innerHTML = emptyState('📭', 'Henüz size atanmış bir iş yok.');
    return;
  }
  area.innerHTML = list.map(i => `
    <div class="card">
      <div class="row1">
        <div class="ad">${esc(i.baslik)}</div>
        <span class="badge ${i.durum === 'Tamamlandi' ? 'olumlu' : 'kararsiz'}">${i.durum === 'Tamamlandi' ? 'Tamamlandı' : 'Bekliyor'}</span>
      </div>
      ${i.aciklama ? `<div class="adres">${esc(i.aciklama)}</div>` : ''}
      <button class="btn btn-outline is-toggle-btn" data-id="${i.id}" data-durum="${i.durum}" style="margin-top:10px;">
        ${i.durum === 'Tamamlandi' ? 'Tamamlanmadı olarak işaretle' : 'Tamamlandı olarak işaretle'}
      </button>
    </div>
  `).join('');
  area.querySelectorAll('.is-toggle-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const yeniDurum = btn.dataset.durum === 'Tamamlandi' ? 'Bekliyor' : 'Tamamlandi';
      btn.disabled = true;
      try {
        await api('toggleIsListem', { isId: btn.dataset.id, durum: yeniDurum });
        renderAnketor();
      } catch (err) {
        showToast('Hata: ' + err.message);
        btn.disabled = false;
      }
    });
  });
}

function renderSandikList(list, aktif) {
  const area = document.getElementById('listArea');
  if (!list.length) {
    area.innerHTML = emptyState('✅', 'Şu anda listede kimse yok.');
    return;
  }
  const banner = !aktif
    ? `<div class="card" style="background:var(--kararsiz-bg); border-color:var(--kararsiz);">
         <b style="color:var(--kararsiz);">Bu bölüm henüz aktif değil</b>
         <div class="field-help" style="margin-top:4px;">26 Eylül'den itibaren "Evet / Hayır" işaretleyebileceksiniz. Şimdilik sadece listeyi görüntüleyebilir, kişileri arayabilirsiniz.</div>
       </div>`
    : '';
  area.innerHTML = banner + list.map(k => {
    const phone = formatPhoneTR(k.telefon);
    return `
    <div class="card kisi-card" data-id="${k.id}" ${aktif ? '' : 'style="cursor:default;"'}>
      <div class="row1">
        <div class="ad">${esc(k.adSoyad)}</div>
        <div class="bolge">${esc(k.bolge)}</div>
      </div>
      <div class="adres">${esc(k.adres || '')}${k.ilce ? ', ' + esc(k.ilce) : ''}</div>
      <div class="meta">
        ${phone.tel
          ? `<a class="tel-link" href="tel:${esc(phone.tel)}">${esc(phone.display)}</a>`
          : `<span class="tel-link tel-missing">${esc(phone.display)}</span>`}
        ${k.ikinciSonuc === 'hayir' ? '<span class="badge olumsuz">Önceki işaret: Hayır</span>' : ''}
      </div>
    </div>`;
  }).join('');

  if (aktif) {
    area.querySelectorAll('.kisi-card').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('tel-link')) return; // aramayı engelleme
        openSandikModal(el.dataset.id, list);
      });
    });
  }
}

function openInterviewModal(id, list) {
  const kisi = list.find(k => String(k.id) === String(id));
  pendingKisiId = id;
  pendingSonuc = null;
  document.getElementById('imKisiAd').textContent = kisi.adSoyad;

  const adresWrap = document.getElementById('imAdresWrap');
  const adresInput = document.getElementById('imAdresInput');
  adresInput.value = '';
  if (kisi.adres) {
    document.getElementById('imKisiMeta').textContent =
      [kisi.adres, kisi.ilce, kisi.telefon].filter(Boolean).join(' · ');
    adresWrap.classList.add('hidden');
  } else {
    document.getElementById('imKisiMeta').textContent =
      [kisi.ilce, kisi.telefon].filter(Boolean).join(' · ');
    adresWrap.classList.remove('hidden');
  }

  document.getElementById('imNotlar').value = '';
  document.querySelectorAll('#interviewModal .choice-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('imSave').disabled = true;
  document.getElementById('interviewModal').classList.remove('hidden');
}

document.querySelectorAll('#interviewModal .choice-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#interviewModal .choice-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    pendingSonuc = btn.dataset.val;
    document.getElementById('imSave').disabled = false;
  });
});
document.getElementById('imCancel').addEventListener('click', () => {
  document.getElementById('interviewModal').classList.add('hidden');
});
document.getElementById('imSave').addEventListener('click', async () => {
  const btn = document.getElementById('imSave');
  btn.disabled = true;
  btn.textContent = 'Kaydediliyor…';
  try {
    await api('submitInterview', {
      kisiId: pendingKisiId,
      sonuc: pendingSonuc,
      notlar: document.getElementById('imNotlar').value,
      adres: document.getElementById('imAdresInput').value.trim()
    });
    document.getElementById('interviewModal').classList.add('hidden');
    showToast('Görüşme kaydedildi.');
    renderAnketor();
  } catch (err) {
    showToast('Hata: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Görüşmeyi Kaydet';
  }
});

// ---- Sandığa Gidildi Oy Kullandı modalı ----
let pendingSandikId = null;
let pendingSandikSonuc = null;

function openSandikModal(id, list) {
  const kisi = list.find(k => String(k.id) === String(id));
  pendingSandikId = id;
  pendingSandikSonuc = null;
  document.getElementById('smKisiAd').textContent = kisi.adSoyad;
  document.getElementById('smKisiMeta').textContent =
    [kisi.adres, kisi.ilce, kisi.telefon].filter(Boolean).join(' · ');
  document.querySelectorAll('#sandikModal .choice-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('smSave').disabled = true;
  document.getElementById('sandikModal').classList.remove('hidden');
}

document.querySelectorAll('#sandikModal .choice-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#sandikModal .choice-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    pendingSandikSonuc = btn.dataset.val;
    document.getElementById('smSave').disabled = false;
  });
});
document.getElementById('smCancel').addEventListener('click', () => {
  document.getElementById('sandikModal').classList.add('hidden');
});
document.getElementById('smSave').addEventListener('click', async () => {
  const btn = document.getElementById('smSave');
  btn.disabled = true;
  btn.textContent = 'Kaydediliyor…';
  try {
    await api('submitSecondInterview', { kisiId: pendingSandikId, sonuc: pendingSandikSonuc });
    document.getElementById('sandikModal').classList.add('hidden');
    showToast('Kaydedildi.');
    renderAnketor();
  } catch (err) {
    showToast('Hata: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Kaydet';
  }
});

// ---- Yeni kişi ekle (anketör) ----
function openYeniKisiModal() {
  document.getElementById('ykAdSoyad').value = '';
  document.getElementById('ykTelefon').value = '';
  document.getElementById('ykAdres').value = '';
  document.getElementById('ykYas').value = '';
  document.getElementById('ykCinsiyet').value = '';
  const bolgeSelect = document.getElementById('ykBolge');
  bolgeSelect.innerHTML = anketorBolgeler.map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('');
  document.getElementById('yeniKisiModal').classList.remove('hidden');
}
document.getElementById('ykCancel').addEventListener('click', () => {
  document.getElementById('yeniKisiModal').classList.add('hidden');
});
document.getElementById('ykSave').addEventListener('click', async () => {
  const adSoyad = document.getElementById('ykAdSoyad').value.trim();
  const bolge = document.getElementById('ykBolge').value;
  if (!adSoyad) { showToast('Ad soyad gerekli.'); return; }
  if (!bolge) { showToast('Bölge bulunamadı — size atanmış bir bölge yok.'); return; }
  const btn = document.getElementById('ykSave');
  btn.disabled = true; btn.textContent = 'Kaydediliyor…';
  try {
    await api('anketorAddKisi', {
      adSoyad,
      telefon: document.getElementById('ykTelefon').value.trim(),
      adres: document.getElementById('ykAdres').value.trim(),
      yas: document.getElementById('ykYas').value.trim(),
      cinsiyet: document.getElementById('ykCinsiyet').value,
      bolge
    });
    document.getElementById('yeniKisiModal').classList.add('hidden');
    showToast('Kişi eklendi.');
    renderAnketor();
  } catch (err) {
    showToast('Hata: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Kaydet';
  }
});

// ---- KVKK modal + imza pedi ----
let sigCtx, sigDrawing = false, sigHasStroke = false;

function openKvkkModal(bolge) {
  pendingKvkkBolge = bolge;
  document.getElementById('kvkkBolgeAd').textContent = bolge;
  document.getElementById('kvkkAdSoyad').value = session.adSoyad;
  document.getElementById('kvkkCheck').checked = false;
  document.getElementById('kvkkConfirm').disabled = true;
  document.getElementById('kvkkModal').classList.remove('hidden');
  setupSignaturePad();
}
document.getElementById('kvkkCheck').addEventListener('change', updateKvkkConfirmState);
document.getElementById('kvkkAdSoyad').addEventListener('input', updateKvkkConfirmState);
function updateKvkkConfirmState() {
  const ok = document.getElementById('kvkkCheck').checked &&
    document.getElementById('kvkkAdSoyad').value.trim().length > 1 &&
    sigHasStroke;
  document.getElementById('kvkkConfirm').disabled = !ok;
}

function setupSignaturePad() {
  const canvas = document.getElementById('sigCanvas');
  const ratio = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * ratio;
  canvas.height = canvas.clientHeight * ratio;
  sigCtx = canvas.getContext('2d');
  sigCtx.scale(ratio, ratio);
  sigCtx.lineWidth = 2.2;
  sigCtx.lineCap = 'round';
  sigCtx.strokeStyle = '#1c2521';
  sigCtx.clearRect(0, 0, canvas.width, canvas.height);
  sigHasStroke = false;

  const pos = e => {
    const r = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  };
  const start = e => { sigDrawing = true; const p = pos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x, p.y); e.preventDefault(); };
  const move = e => {
    if (!sigDrawing) return;
    const p = pos(e); sigCtx.lineTo(p.x, p.y); sigCtx.stroke();
    sigHasStroke = true; updateKvkkConfirmState(); e.preventDefault();
  };
  const end = () => { sigDrawing = false; };

  canvas.onmousedown = start; canvas.onmousemove = move;
  window.onmouseup = end;
  canvas.ontouchstart = start; canvas.ontouchmove = move; canvas.ontouchend = end;
}
document.getElementById('sigClear').addEventListener('click', () => setupSignaturePad());

document.getElementById('kvkkConfirm').addEventListener('click', async () => {
  const btn = document.getElementById('kvkkConfirm');
  btn.disabled = true; btn.textContent = 'Kaydediliyor…';
  try {
    const dataUrl = document.getElementById('sigCanvas').toDataURL('image/png');
    await api('saveKvkkOnay', {
      bolge: pendingKvkkBolge,
      adSoyad: document.getElementById('kvkkAdSoyad').value.trim(),
      imzaDataUrl: dataUrl
    });
    document.getElementById('kvkkModal').classList.add('hidden');
    showToast('KVKK onayı kaydedildi.');
    renderAnketor();
  } catch (err) {
    showToast('Hata: ' + err.message);
  } finally {
    btn.textContent = 'Onayla ve Listeyi Görüntüle';
  }
});

// =================================================================
// YÖNETİCİ AKIŞI
// =================================================================
function renderAdmin() {
  const main = document.getElementById('mainContent');
  main.innerHTML = `
    <h1>Yönetici Paneli</h1>
    <div class="tabstrip">
      <button data-t="yukle">Kişi Yükle</button>
      <button data-t="anketorler">Anketörler</button>
      <button data-t="isler">İş Listesi</button>
      <button data-t="kisiler">Görüşülenler</button>
      <button data-t="kvkk">KVKK Kayıtları</button>
      <button data-t="analiz">Analiz</button>
      <button data-t="sandik">Sandık Analizi</button>
    </div>
    <div id="adminBody"><p class="lede">Yükleniyor…</p></div>
  `;
  main.querySelectorAll('.tabstrip button').forEach(b => {
    if (b.dataset.t === adminTab) b.classList.add('active');
    b.addEventListener('click', () => {
      adminTab = b.dataset.t;
      renderAdmin();
    });
  });
  renderAdminTab();
}

function renderAdminTab() {
  if (adminTab === 'yukle') return renderAdminYukle();
  if (adminTab === 'anketorler') return renderAdminAnketorler();
  if (adminTab === 'isler') return renderAdminIsListesi();
  if (adminTab === 'kisiler') return renderAdminKisiler();
  if (adminTab === 'kvkk') return renderAdminKvkk();
  if (adminTab === 'analiz') return renderAdminAnaliz();
  if (adminTab === 'sandik') return renderAdminSandik();
}

// ---- Kişi yükle (Excel) ----
function renderAdminYukle() {
  const body = document.getElementById('adminBody');
  body.innerHTML = `
    <p class="lede">Excel dosyasındaki sütun başlıkları: <b>AdSoyad, Telefon, Adres, Ilce, Bolge, Yas, Cinsiyet</b> (büyük/küçük harf önemli değil). "Bolge" sütunu, kişinin hangi anketöre gideceğini belirler — bölge daha önce bir anketöre atanmamışsa kişi "atanmamış" olarak beklemeye alınır.</p>
    <div class="upload-drop" id="dropZone">
      <div class="ic">📄</div>
      <div><b>Excel dosyası seçin</b> (.xlsx / .xls / .csv)</div>
      <input type="file" id="fileInput" accept=".xlsx,.xls,.csv" style="display:none;">
    </div>
    <div id="uploadSummary"></div>
    <button class="btn btn-primary btn-block" id="uploadBtn" style="margin-top:14px;" disabled>Listeyi Sisteme Yükle</button>
  `;
  const dz = document.getElementById('dropZone');
  const fi = document.getElementById('fileInput');
  dz.addEventListener('click', () => fi.click());
  fi.addEventListener('change', handleExcelFile);
  document.getElementById('uploadBtn').addEventListener('click', doUploadKisiler);
}

function handleExcelFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = evt => {
    const wb = XLSX.read(evt.target.result, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    parsedExcelRows = raw.map(r => normalizeRow(r)).filter(r => r.adSoyad);
    document.getElementById('uploadSummary').innerHTML =
      `<p class="upload-summary"><b>${parsedExcelRows.length}</b> satır okundu. "Sisteme Yükle" ile devam edin.</p>`;
    document.getElementById('uploadBtn').disabled = parsedExcelRows.length === 0;
  };
  reader.readAsArrayBuffer(file);
}

function normalizeRow(r) {
  const get = keys => {
    for (const k of Object.keys(r)) {
      if (keys.indexOf(k.toLowerCase().replace(/\s/g, '')) !== -1) return String(r[k]).trim();
    }
    return '';
  };
  return {
    adSoyad: get(['adsoyad', 'ad soyad', 'isim', 'adisoyadi']),
    telefon: get(['telefon', 'tel', 'iletisim', 'iletişim']),
    adres: get(['adres']),
    ilce: get(['ilce', 'ilçe']),
    bolge: get(['bolge', 'bölge']),
    yas: get(['yas', 'yaş']),
    cinsiyet: get(['cinsiyet'])
  };
}

async function doUploadKisiler() {
  const btn = document.getElementById('uploadBtn');
  btn.disabled = true; btn.textContent = 'Yükleniyor…';
  try {
    const res = await api('adminUploadKisiler', { rows: parsedExcelRows });
    showToast(`${res.eklenen} kişi eklendi (${res.atanan} anketöre atandı, ${res.atanmayan} bekliyor).`);
    parsedExcelRows = [];
    kisilerCache = null;
    renderAdminTab();
  } catch (err) {
    showToast('Hata: ' + err.message);
  } finally {
    btn.textContent = 'Listeyi Sisteme Yükle';
  }
}

// ---- Anketörler ----
async function renderAdminAnketorler() {
  const body = document.getElementById('adminBody');
  body.innerHTML = `<p class="lede">Yükleniyor…</p>`;
  let data;
  try {
    data = await api('adminGetAnketorler', {});
  } catch (err) {
    body.innerHTML = emptyState('⚠️', err.message);
    return;
  }
  body.innerHTML = `
    <div class="card">
      <h2>Yeni Anketör Ekle / Güncelle</h2>
      <label for="naEmail">Gmail Adresi</label>
      <input type="email" id="naEmail" placeholder="ornek@gmail.com">
      <label for="naAd">Ad Soyad</label>
      <input type="text" id="naAd" placeholder="Ad Soyad">
      <label for="naBolgeler">Bölgeler (virgülle ayırın)</label>
      <input type="text" id="naBolgeler" placeholder="Kadıköy, Üsküdar">
      <button class="btn btn-primary btn-block" id="naSave" style="margin-top:14px;">Kaydet</button>
    </div>

    <h2 style="margin-top:22px;">Anketörler (${data.anketorler.length})</h2>
    <div id="anketorList"></div>

    <div class="card" style="margin-top:18px;">
      <h2>Bölgeyi Anketöre Ata</h2>
      <p class="lede" style="margin-bottom:10px;">Yeni bir bölge tanımlamak ya da mevcut bir bölgeyi başka bir anketöre devretmek için kullanın.</p>
      <label for="abBolge">Bölge</label>
      <input type="text" id="abBolge" placeholder="Örn. Kadıköy">
      <label for="abEmail">Anketör Gmail</label>
      <input type="email" id="abEmail" placeholder="ornek@gmail.com">
      <button class="btn btn-outline btn-block" id="abSave" style="margin-top:14px;">Ata</button>
    </div>
  `;
  document.getElementById('anketorList').innerHTML = data.anketorler.map(a => `
    <div class="card">
      <div class="row1"><div class="ad">${esc(a.adSoyad)}</div><div class="bolge">${a.tamamlanan}/${a.toplamKisi} tamamlandı</div></div>
      <div class="adres">${esc(a.email)}</div>
      <div class="chip-list">${a.bolgeler.map(b => `<span class="chip">${esc(b)}</span>`).join('') || '<span class="field-help">Henüz bölge atanmadı</span>'}</div>
    </div>
  `).join('');

  document.getElementById('naSave').addEventListener('click', async () => {
    const email = document.getElementById('naEmail').value.trim();
    const adSoyad = document.getElementById('naAd').value.trim();
    const bolgeler = document.getElementById('naBolgeler').value.split(',').map(s => s.trim()).filter(Boolean);
    if (!email || !adSoyad) { showToast('E-posta ve ad soyad gerekli.'); return; }
    try {
      await api('adminAddAnketor', { email, adSoyad, bolgeler });
      showToast('Anketör kaydedildi.');
      renderAdminTab();
    } catch (err) { showToast('Hata: ' + err.message); }
  });

  document.getElementById('abSave').addEventListener('click', async () => {
    const bolge = document.getElementById('abBolge').value.trim();
    const anketorEmail = document.getElementById('abEmail').value.trim();
    if (!bolge || !anketorEmail) { showToast('Bölge ve anketör e-postası gerekli.'); return; }
    try {
      await api('adminAssignBolge', { bolge, anketorEmail });
      showToast('Bölge ataması yapıldı.');
      renderAdminTab();
    } catch (err) { showToast('Hata: ' + err.message); }
  });
}

// ---- İş Listesi (yönetici) ----
async function renderAdminIsListesi() {
  const body = document.getElementById('adminBody');
  body.innerHTML = `<p class="lede">Yükleniyor…</p>`;
  let anketorData, isData;
  try {
    [anketorData, isData] = await Promise.all([
      api('adminGetAnketorler', {}),
      api('adminGetIsListeleri', {})
    ]);
  } catch (err) {
    body.innerHTML = emptyState('⚠️', err.message);
    return;
  }
  body.innerHTML = `
    <div class="card">
      <h2>Yeni İş Ata</h2>
      <label for="ilAnketor">Anketör</label>
      <select id="ilAnketor">
        ${anketorData.anketorler.map(a => `<option value="${esc(a.email)}">${esc(a.adSoyad)} (${esc(a.email)})</option>`).join('')}
      </select>
      <label for="ilBaslik">Başlık</label>
      <input type="text" id="ilBaslik" placeholder="Örn. Kadıköy sahil mahallesini tara">
      <label for="ilAciklama">Açıklama</label>
      <textarea id="ilAciklama" placeholder="Detaylar (opsiyonel)"></textarea>
      <button class="btn btn-primary btn-block" id="ilSave" style="margin-top:14px;">Ata</button>
    </div>

    <h2 style="margin-top:22px;">Atanan İşler (${isData.isListeleri.length})</h2>
    <div id="isListArea"></div>
  `;

  const isListArea = document.getElementById('isListArea');
  if (!isData.isListeleri.length) {
    isListArea.innerHTML = emptyState('📭', 'Henüz iş ataması yapılmadı.');
  } else {
    isListArea.innerHTML = isData.isListeleri.slice().reverse().map(i => `
      <div class="card">
        <div class="row1">
          <div class="ad">${esc(i.baslik)}</div>
          <span class="badge ${i.durum === 'Tamamlandi' ? 'olumlu' : 'kararsiz'}">${i.durum === 'Tamamlandi' ? 'Tamamlandı' : 'Bekliyor'}</span>
        </div>
        <div class="adres">${esc(i.anketorAd)}</div>
        ${i.aciklama ? `<div class="field-help" style="margin-top:6px;">${esc(i.aciklama)}</div>` : ''}
      </div>`).join('');
  }

  document.getElementById('ilSave').addEventListener('click', async () => {
    const anketorEmail = document.getElementById('ilAnketor').value;
    const baslik = document.getElementById('ilBaslik').value.trim();
    const aciklama = document.getElementById('ilAciklama').value.trim();
    if (!anketorEmail || !baslik) { showToast('Anketör ve başlık gerekli.'); return; }
    try {
      await api('adminAssignIsListesi', { anketorEmail, baslik, aciklama });
      showToast('İş atandı.');
      renderAdminTab();
    } catch (err) { showToast('Hata: ' + err.message); }
  });
}

// ---- Görüşülenler (sonuca göre filtre) ----
let kisilerFilter = 'olumlu';
let kisilerCache = null;
let kisilerArama = '';

async function renderAdminKisiler() {
  const body = document.getElementById('adminBody');
  body.innerHTML = `
    <p class="lede">Görüşülen kişileri sonuca göre filtreleyin. Bir satıra dokunarak görüşme notunu, sonucu değiştirme seçeneğini ve yönetici notunu görüntüleyin; telefon numarasına dokunarak arayın.</p>
    <div class="choice-row choice-row-4" id="kisilerFilterRow">
      <button class="choice-btn sel-olumlu" data-f="olumlu">Olumlu</button>
      <button class="choice-btn sel-olumsuz" data-f="olumsuz">Olumsuz</button>
      <button class="choice-btn sel-kararsiz" data-f="kararsiz">Kararsız</button>
      <button class="choice-btn sel-oykullanamaz" data-f="oykullanamaz">Oy Kullanamayacak</button>
    </div>
    <input type="text" id="kisilerAramaInput" placeholder="İsimle ara…" style="margin-top:12px;">
    <div id="kisilerListArea" style="margin-top:14px;"><p class="lede">Yükleniyor…</p></div>
  `;
  document.getElementById('kisilerAramaInput').addEventListener('input', (e) => {
    kisilerArama = e.target.value.trim();
    renderKisilerFilteredList();
  });
  document.querySelectorAll('#kisilerFilterRow .choice-btn').forEach(b => {
    if (b.dataset.f === kisilerFilter) b.classList.add('selected');
    b.addEventListener('click', () => {
      kisilerFilter = b.dataset.f;
      document.querySelectorAll('#kisilerFilterRow .choice-btn').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      renderKisilerFilteredList();
    });
  });
  try {
    if (!kisilerCache) {
      const data = await api('adminGetAllKisiler', {});
      kisilerCache = data.kisiler;
    }
    renderKisilerFilteredList();
  } catch (err) {
    document.getElementById('kisilerListArea').innerHTML = emptyState('⚠️', err.message);
  }
}

// Telefon numarasını Türkiye standart görünümüne (0 5xx xxx xxxx) çevirir
// ve aranabilir (tel:) bir değer üretir. Numara +90/90/0 önekiyle,
// boşluklu/tireli ya da eksik biçimde girilmiş olsa da normalize eder.
function formatPhoneTR(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('0090')) digits = digits.slice(2);
  if (digits.startsWith('90') && digits.length === 12) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);

  if (digits.length === 10 && digits.startsWith('5')) {
    return {
      display: '0 ' + digits.slice(0, 3) + ' ' + digits.slice(3, 6) + ' ' + digits.slice(6, 10),
      tel: '+90' + digits,
      valid: true
    };
  }
  // Tanınamayan bir biçimse yine de aranabilir bir değer üretmeye çalış,
  // görünümde ham veriyi bırak.
  return {
    display: raw ? String(raw) : '—',
    tel: digits ? (digits.startsWith('0') ? '+90' + digits.slice(1) : '+' + digits) : '',
    valid: false
  };
}

function renderKisilerFilteredList() {
  const area = document.getElementById('kisilerListArea');
  let list = (kisilerCache || []).filter(k => k.IlkSonuc === kisilerFilter);
  if (kisilerArama.length > 0) {
    const q = normalizeTR(kisilerArama);
    list = list.filter(k => normalizeTR(k.AdSoyad).includes(q));
  }
  if (!list.length) {
    area.innerHTML = emptyState('📭', kisilerArama.length > 0 ? 'Aramanızla eşleşen kişi bulunamadı.' : 'Bu sonuçta görüşülmüş kimse yok.');
    return;
  }
  area.innerHTML = list.map(k => {
    const phone = formatPhoneTR(k.Telefon);
    return `
    <div class="card kisi-row" data-id="${k.ID}">
      <div class="kisi-row-header">
        <div class="row1">
          <div class="ad">${esc(k.AdSoyad)}</div>
          ${phone.tel
            ? `<a class="tel-link" href="tel:${esc(phone.tel)}">${esc(phone.display)}</a>`
            : `<span class="tel-link tel-missing">${esc(phone.display)}</span>`}
        </div>
        <div class="adres">${esc(k.Bolge || '—')} · ${esc(k.AnketorAd || '—')}</div>
      </div>
      <div class="notes-area hidden" data-id="${k.ID}">
        <div class="field-help" style="margin-bottom:6px;">Anketör notu</div>
        <div style="margin-bottom:14px;">${k.IlkNotlar ? esc(k.IlkNotlar) : '<span class="field-help">Not girilmemiş.</span>'}</div>

        <label style="margin-top:0;">Görüşme Sonucunu Değiştir</label>
        <div class="choice-row admin-sonuc-row choice-row-4">
          <button class="choice-btn sel-olumlu${k.IlkSonuc === 'olumlu' ? ' selected' : ''}" data-val="olumlu">Olumlu</button>
          <button class="choice-btn sel-olumsuz${k.IlkSonuc === 'olumsuz' ? ' selected' : ''}" data-val="olumsuz">Olumsuz</button>
          <button class="choice-btn sel-kararsiz${k.IlkSonuc === 'kararsiz' ? ' selected' : ''}" data-val="kararsiz">Kararsız</button>
          <button class="choice-btn sel-oykullanamaz${k.IlkSonuc === 'oykullanamaz' ? ' selected' : ''}" data-val="oykullanamaz">Oy Kullanamayacak</button>
        </div>

        <label for="yn-${k.ID}">Yönetici Notu</label>
        <textarea id="yn-${k.ID}" placeholder="Bu kişiyle ilgili yönetici notu ekleyin">${esc(k.YoneticiNotu || '')}</textarea>

        <button class="btn btn-primary admin-save-btn" style="margin-top:10px;">Kaydet</button>

        <label for="rg-${k.ID}" style="margin-top:18px;">Anketöre Tekrar Görüşme İşi Ata</label>
        <textarea id="rg-${k.ID}" placeholder="Anketöre iletilecek görev notu (opsiyonel)"></textarea>
        <button class="btn btn-outline reassign-btn" style="margin-top:10px;">🔁 Tekrar Görüşme İşi Ata</button>
      </div>
    </div>
  `;
  }).join('');

  area.querySelectorAll('.kisi-row-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.classList.contains('tel-link')) return; // aramayı engelleme
      header.closest('.kisi-row').querySelector('.notes-area').classList.toggle('hidden');
    });
  });

  area.querySelectorAll('.kisi-row').forEach(card => {
    const id = card.dataset.id;
    const sonucRow = card.querySelector('.admin-sonuc-row');
    let secilenSonuc = (kisilerCache.find(k => String(k.ID) === id) || {}).IlkSonuc;

    sonucRow.querySelectorAll('.choice-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        sonucRow.querySelectorAll('.choice-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        secilenSonuc = btn.dataset.val;
      });
    });

    card.querySelector('.admin-save-btn').addEventListener('click', async (btnEvt) => {
      const saveBtn = btnEvt.currentTarget;
      const textarea = card.querySelector('textarea');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Kaydediliyor…';
      try {
        await api('adminUpdateKisi', {
          kisiId: id,
          yeniSonuc: secilenSonuc,
          yoneticiNotu: textarea.value
        });
        const cacheItem = kisilerCache.find(k => String(k.ID) === id);
        if (cacheItem) {
          cacheItem.IlkSonuc = secilenSonuc;
          cacheItem.YoneticiNotu = textarea.value;
        }
        showToast('Kaydedildi.');
        renderKisilerFilteredList();
      } catch (err) {
        showToast('Hata: ' + err.message);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Kaydet';
      }
    });

    card.querySelector('.reassign-btn').addEventListener('click', async (btnEvt) => {
      const btn = btnEvt.currentTarget;
      const gorevNotu = document.getElementById('rg-' + id).value;
      btn.disabled = true;
      btn.textContent = 'Atanıyor…';
      try {
        await api('adminAssignYenidenGorusmeIsi', { kisiId: id, gorevNotu });
        showToast('Anketöre tekrar görüşme işi atandı.');
        document.getElementById('rg-' + id).value = '';
      } catch (err) {
        showToast('Hata: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = '🔁 Tekrar Görüşme İşi Ata';
      }
    });
  });
}

// ---- KVKK kayıtları ----
async function renderAdminKvkk() {
  const body = document.getElementById('adminBody');
  body.innerHTML = `<p class="lede">Yükleniyor…</p>`;
  let data;
  try {
    data = await api('adminGetKvkkRecords', {});
  } catch (err) {
    body.innerHTML = emptyState('⚠️', err.message);
    return;
  }
  if (!data.kayitlar.length) {
    body.innerHTML = emptyState('📄', 'Henüz KVKK onayı verilmemiş.');
    return;
  }
  body.innerHTML = `
    <p class="lede">Anketörlerin bölge bazlı KVKK onay ve imza kayıtları.</p>
    <div class="table-scroll"><table class="data-table">
      <thead><tr><th>Anketör</th><th>Bölge</th><th>Tarih</th><th>İmza</th></tr></thead>
      <tbody>
        ${data.kayitlar.map((k, i) => `
          <tr>
            <td>${esc(k.anketorAd || k.anketorEmail)}</td>
            <td>${esc(k.bolge)}</td>
            <td>${formatDate(k.tarih)}</td>
            <td><button class="btn btn-outline" data-i="${i}" style="padding:5px 10px; min-height:auto;">Göster</button></td>
          </tr>`).join('')}
      </tbody>
    </table></div>
  `;
  body.querySelectorAll('button[data-i]').forEach(btn => {
    btn.addEventListener('click', () => {
      const rec = data.kayitlar[Number(btn.dataset.i)];
      document.getElementById('sigViewImg').src = rec.imzaDataUrl;
      document.getElementById('sigViewModal').classList.remove('hidden');
    });
  });
}
document.getElementById('sigViewClose').addEventListener('click', () => {
  document.getElementById('sigViewModal').classList.add('hidden');
});

// ---- Analiz ----
async function renderAdminAnaliz() {
  const body = document.getElementById('adminBody');
  body.innerHTML = `<p class="lede">Yükleniyor…</p>`;
  let data;
  try {
    data = await api('adminGetAnalysis', {});
  } catch (err) {
    body.innerHTML = emptyState('⚠️', err.message);
    return;
  }
  if (!data.toplamGorusulen) {
    body.innerHTML = emptyState('📊', 'Henüz tamamlanmış görüşme yok. Sonuçlar burada görünecek.');
    return;
  }
  const oranHesapla = n => data.toplamGorusulen ? Math.round((n / data.toplamGorusulen) * 100) : 0;
  body.innerHTML = `
    <div class="stat-grid">
      <div class="stat-box"><div class="n">${data.toplamGorusulen}</div><div class="lbl">Toplam Görüşme</div></div>
      <div class="stat-box"><div class="n">${oranHesapla(data.toplamOlumlu)}%</div><div class="count-sub">${data.toplamOlumlu} kişi</div><div class="lbl">Olumlu Oranı</div></div>
      <div class="stat-box"><div class="n">${oranHesapla(data.toplamOlumsuz)}%</div><div class="count-sub">${data.toplamOlumsuz} kişi</div><div class="lbl">Olumsuz Oranı</div></div>
      <div class="stat-box"><div class="n">${oranHesapla(data.toplamKararsiz)}%</div><div class="count-sub">${data.toplamKararsiz} kişi</div><div class="lbl">Kararsız Oranı</div></div>
      <div class="stat-box"><div class="n">${oranHesapla(data.toplamOyKullanamaz)}%</div><div class="count-sub">${data.toplamOyKullanamaz} kişi</div><div class="lbl">Oy Kullanamayacak Oranı</div></div>
    </div>
    ${analysisTable('Anketöre Göre Sonuçlar', data.anketorBazli)}
    ${analysisSection('Bölgeye Göre (adres yakınlığı)', data.bolgeBazli)}
    ${analysisSection('Cinsiyete Göre', data.cinsiyetBazli)}
  `;
}

function analysisTable(title, buckets) {
  if (!buckets.length) return '';
  const rows = buckets
    .slice()
    .sort((a, b) => b.toplam - a.toplam)
    .map(b => `
      <tr>
        <td>${esc(b.ad)}</td>
        <td><span class="badge olumlu">${b.olumlu || 0}</span></td>
        <td><span class="badge olumsuz">${b.olumsuz || 0}</span></td>
        <td><span class="badge kararsiz">${b.kararsiz || 0}</span></td>
        <td><span class="badge oykullanamaz">${b.oykullanamaz || 0}</span></td>
        <td>${b.toplam}</td>
      </tr>`).join('');
  return `<div class="card"><h2>${title}</h2>
    <div class="table-scroll"><table class="data-table">
      <thead><tr><th>Anketör</th><th>Olumlu</th><th>Olumsuz</th><th>Kararsız</th><th>Oy Kullanamayacak</th><th>Toplam</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

function analysisSection(title, buckets) {
  if (!buckets.length) return '';
  const rows = buckets
    .slice()
    .sort((a, b) => b.toplam - a.toplam)
    .map(b => {
      const w = k => Math.round(((b[k] || 0) / b.toplam) * 1000) / 10;
      return `
      <div class="bar-row">
        <div class="bar-label"><span>${esc(b.ad)}</span><span class="field-help">${b.toplam} görüşme</span></div>
        <div class="bar-track">
          <div class="seg-olumlu" style="width:${w('olumlu')}%"></div>
          <div class="seg-olumsuz" style="width:${w('olumsuz')}%"></div>
          <div class="seg-kararsiz" style="width:${w('kararsiz')}%"></div>
          <div class="seg-oykullanamaz" style="width:${w('oykullanamaz')}%"></div>
        </div>
      </div>`;
    }).join('');
  return `<div class="card"><h2>${title}</h2>${rows}</div>`;
}

// ---- Sandık Analizi (olumlu oy kullanıp sandığa gelenler/gelmeyenler) ----
async function renderAdminSandik() {
  const body = document.getElementById('adminBody');
  body.innerHTML = `<p class="lede">Yükleniyor…</p>`;
  let data;
  try {
    data = await api('adminGetSandikAnalizi', {});
  } catch (err) {
    body.innerHTML = emptyState('⚠️', err.message);
    return;
  }
  if (!data.toplamOlumlu) {
    body.innerHTML = emptyState('🗳️', 'Henüz olumlu işaretlenmiş kimse yok. Sonuçlar burada görünecek.');
    return;
  }
  const genelOran = data.toplamOlumlu ? Math.round((data.toplamOyKullandi / data.toplamOlumlu) * 1000) / 10 : 0;
  body.innerHTML = `
    <p class="lede">İlk görüşmede olumlu bulunanlardan sandığa gidip oy kullandığı teyit edilenlerin analizi.</p>
    <div class="stat-grid">
      <div class="stat-box"><div class="n">${data.toplamOlumlu}</div><div class="lbl">Toplam Olumlu</div></div>
      <div class="stat-box"><div class="n">${data.toplamOyKullandi}</div><div class="lbl">Sandığa Geldi</div></div>
      <div class="stat-box"><div class="n">${genelOran}%</div><div class="lbl">Katılım Oranı</div></div>
    </div>
    ${sandikTable('Bölgeye Göre', 'Bölge', data.bolgeBazli)}
    ${sandikTable('Cinsiyete Göre', 'Cinsiyet', data.cinsiyetBazli)}
    ${sandikTable('Anketöre Göre', 'Anketör', data.anketorBazli)}
    ${gelmeyenlerTable(data.gelmeyenListe)}
  `;
}

function sandikTable(title, dimLabel, buckets) {
  if (!buckets.length) return '';
  const rows = buckets
    .slice()
    .sort((a, b) => b.toplamOlumlu - a.toplamOlumlu)
    .map(b => `
      <tr>
        <td>${esc(b.ad)}</td>
        <td>${b.toplamOlumlu}</td>
        <td><span class="badge olumlu">${b.oyKullandi}</span></td>
        <td><span class="badge olumsuz">${b.gelmedi}</span></td>
        <td>${b.oran}%</td>
      </tr>`).join('');
  return `<div class="card"><h2>${title}</h2>
    <div class="table-scroll"><table class="data-table">
      <thead><tr><th>${dimLabel}</th><th>Olumlu</th><th>Sandığa Geldi</th><th>Gelmedi</th><th>Katılım</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

function gelmeyenlerTable(list) {
  if (!list.length) {
    return `<div class="card"><h2>Sandığa Gelmeyenler</h2>
      <p class="lede" style="margin-bottom:0;">Olumlu oy kullanıp sandığa gelmeyen kimse yok 🎉</p></div>`;
  }
  const rows = list.map(k => {
    const phone = formatPhoneTR(k.telefon);
    return `
      <tr>
        <td>${esc(k.adSoyad)}</td>
        <td>${phone.tel
          ? `<a class="tel-link" href="tel:${esc(phone.tel)}">${esc(phone.display)}</a>`
          : esc(phone.display)}</td>
        <td>${esc(k.bolge)}</td>
        <td>${k.notlar ? esc(k.notlar) : '<span class="field-help">—</span>'}</td>
      </tr>`;
  }).join('');
  return `<div class="card"><h2>Sandığa Gelmeyenler (${list.length})</h2>
    <div class="table-scroll"><table class="data-table">
      <thead><tr><th>İsim</th><th>Telefon</th><th>Bölge</th><th>Not</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

// ---------------------------------------------------------------
// YARDIMCILAR
// ---------------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function formatDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return d.toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
