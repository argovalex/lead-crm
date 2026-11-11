document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target));
  const r = await fetch('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fd) });
  if (r.ok) location.href = '/';
  else document.getElementById('err').textContent = r.status === 429 ? 'יותר מדי ניסיונות, נסה שוב מאוחר יותר' : 'פרטי התחברות שגויים';
});
