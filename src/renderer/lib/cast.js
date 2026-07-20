'use strict';
// Chromecast / DLNA device picker. Classic script sharing the global scope with
// renderer.js (uses esc, t, toast and the window.api cast bridge).

let castTargetId = null;

async function openCastPicker(id) {
  castTargetId = id;
  const modal = document.getElementById('cast-modal');
  const scanning = document.getElementById('cast-scanning');
  const deviceList = document.getElementById('device-list');
  const castEmpty = document.getElementById('cast-empty');

  scanning.classList.remove('hidden');
  deviceList.classList.add('hidden');
  castEmpty.classList.add('hidden');
  deviceList.textContent = '';
  modal.classList.remove('hidden');

  scanning.textContent = t('cast.scanning');
  try {
    const devices = await window.api.discoverDevices();
    scanning.classList.add('hidden');
    if (!devices.length) {
      castEmpty.textContent = t('cast.noDevices');
      castEmpty.classList.remove('hidden');
    } else {
      for (const d of devices) {
        const item = document.createElement('button');
        item.className = 'file-item';
        item.innerHTML = `<span class="file-item-name">📺 ${esc(d.name)}</span><span class="file-item-size">${esc(d.host)}</span>`;
        item.addEventListener('click', async () => {
          closeCastModal();
          try {
            await window.api.castToDevice(castTargetId, d.host, d.type);
            toast(t('cast.started', { name: d.name }));
          } catch (err) {
            toast(err.message, true);
          }
        });
        deviceList.appendChild(item);
      }
      deviceList.classList.remove('hidden');
    }
  } catch (err) {
    scanning.classList.add('hidden');
    castEmpty.textContent = t('cast.error', { msg: err.message });
    castEmpty.classList.remove('hidden');
  }
}

function closeCastModal() {
  document.getElementById('cast-modal').classList.add('hidden');
  castTargetId = null;
}
