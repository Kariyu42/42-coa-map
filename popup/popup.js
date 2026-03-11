document.getElementById('open-tab-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') });
});

const clientIdInput = document.getElementById('client-id');
const clientSecretInput = document.getElementById('client-secret');
const saveBtn = document.getElementById('save-btn');
const clearCacheBtn = document.getElementById('clear-cache-btn');
const statusEl = document.getElementById('status');

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
}

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

// Load saved credentials on open
chrome.storage.local.get(['client_id', 'client_secret'], ({ client_id, client_secret }) => {
  if (client_id) clientIdInput.value = client_id;
  if (client_secret) clientSecretInput.value = client_secret;
});

saveBtn.addEventListener('click', async () => {
  const clientId = clientIdInput.value.trim();
  const clientSecret = clientSecretInput.value.trim();

  if (!clientId || !clientSecret) {
    showStatus('Both Client UID and Client Secret are required.', 'error');
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Testing…';
  statusEl.className = 'status hidden';

  // Save credentials first (so background can use them)
  await new Promise((resolve) =>
    chrome.storage.local.set(
      { client_id: clientId, client_secret: clientSecret, oauth_token: null },
      resolve
    )
  );

  try {
    const res = await sendMessage({ type: 'TEST_CREDENTIALS' });
    if (res?.ok) {
      showStatus('Credentials saved and verified!', 'success');
    } else {
      showStatus(`Authentication failed: ${res?.error ?? 'Unknown error'}`, 'error');
    }
  } catch (err) {
    showStatus(`Error: ${err.message}`, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save & Test';
  }
});

clearCacheBtn.addEventListener('click', async () => {
  clearCacheBtn.disabled = true;
  try {
    await sendMessage({ type: 'CLEAR_CACHE' });
    showStatus('Coalition cache cleared.', 'success');
  } catch (err) {
    showStatus(`Error: ${err.message}`, 'error');
  } finally {
    clearCacheBtn.disabled = false;
  }
});
