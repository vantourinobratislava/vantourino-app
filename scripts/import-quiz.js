const fs = require('fs');

const BASE = 'https://app.bratislavabiketour.com';

async function main() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    throw new Error('Set ADMIN_USERNAME and ADMIN_PASSWORD env vars first.');
  }

  const raw = fs.readFileSync('./bratislava_quiz_multilang_import.json', 'utf8');
  const payload = JSON.parse(raw);

  // 1) login
  const loginRes = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  if (!loginRes.ok) {
    const txt = await loginRes.text();
    throw new Error(`Login failed: ${loginRes.status} ${txt}`);
  }

  const cookie = loginRes.headers.get('set-cookie');
  if (!cookie) {
    throw new Error('No session cookie returned from login.');
  }

  // 2) create quiz
  const createQuizRes = await fetch(`${BASE}/api/admin/quizzes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({
      translations: payload.translations,
    }),
  });

  if (!createQuizRes.ok) {
    const txt = await createQuizRes.text();
    throw new Error(`Create quiz failed: ${createQuizRes.status} ${txt}`);
  }

  const quiz = await createQuizRes.json();
  const quizId = quiz.id;

  console.log('Quiz created:', quizId);

  // 3) add questions
  for (const q of payload.questions) {
    const res = await fetch(`${BASE}/api/admin/quizzes/${quizId}/questions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify(q),
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Add question failed for order ${q.orderIndex}: ${res.status} ${txt}`);
    }

    const data = await res.json();
    console.log('Added question:', data.question.id, 'order', q.orderIndex);
  }

  console.log('Import finished successfully. Quiz ID:', quizId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
