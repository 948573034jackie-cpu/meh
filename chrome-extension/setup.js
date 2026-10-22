const msg = document.getElementById('msg');

document.getElementById('allow').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    msg.textContent = '✅ Done! Close this tab, click the ClaudeSnap icon, and press Open.';
    msg.style.color = '#188038';
  } catch (e) {
    msg.textContent = '❌ Microphone was blocked (' + e.name + '). Click the lock icon in the address bar, allow Microphone, then try again.';
    msg.style.color = '#d93025';
  }
});
