/**
 * ZeroPack SNS 자동 포스팅 스크립트
 * Twitter + LinkedIn + Threads 동시 발행
 *
 * 환경변수 (GitHub Secrets):
 *   TWITTER_API_KEY, TWITTER_API_SECRET
 *   TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET
 *   LINKEDIN_ACCESS_TOKEN, LINKEDIN_PERSON_ID
 *   THREADS_ACCESS_TOKEN, THREADS_USER_ID
 */

import { readFileSync, writeFileSync } from 'fs';
import crypto from 'crypto';

// ── 날짜 (KST 기준) ─────────────────────────────────────────────────────────
const now = new Date();
const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
const today = kst.toISOString().split('T')[0]; // YYYY-MM-DD

// ── 스케줄 로드 ──────────────────────────────────────────────────────────────
const schedule = JSON.parse(readFileSync('./social/schedule.json', 'utf8'));
const todayPost = schedule.posts.find(p => p.date === today && !p.posted);

if (!todayPost) {
  console.log(`[${today}] 오늘 예약된 포스팅 없음. 종료.`);
  process.exit(0);
}

console.log(`[${today}] 포스팅 시작: ID ${todayPost.id}`);
console.log(`내용 미리보기: ${todayPost.text.substring(0, 60)}...`);

// ── OAuth 1.0a 서명 (Twitter) ────────────────────────────────────────────────
function buildOAuth1Header(method, url) {
  const {
    TWITTER_API_KEY: ck,
    TWITTER_API_SECRET: cs,
    TWITTER_ACCESS_TOKEN: at,
    TWITTER_ACCESS_TOKEN_SECRET: ats,
  } = process.env;

  const oauthParams = {
    oauth_consumer_key:     ck,
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        String(Math.floor(Date.now() / 1000)),
    oauth_token:            at,
    oauth_version:          '1.0',
  };

  const sorted = Object.entries(oauthParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .join('&');

  const base = [method.toUpperCase(), enc(url), enc(sorted)].join('&');
  const sigKey = `${enc(cs)}&${enc(ats)}`;
  const sig = crypto.createHmac('sha1', sigKey).update(base).digest('base64');

  oauthParams.oauth_signature = sig;

  return 'OAuth ' + Object.entries(oauthParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${enc(k)}="${enc(v)}"`)
    .join(', ');
}

function enc(s) { return encodeURIComponent(s); }

// ── Twitter 포스팅 ────────────────────────────────────────────────────────────
async function postToTwitter(text) {
  const url = 'https://api.twitter.com/2/tweets';
  const auth = buildOAuth1Header('POST', url);

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  const data = await res.json();
  if (res.ok) {
    console.log(`✅ Twitter 발행 완료: ${data.data?.id}`);
    return { ok: true, id: data.data?.id };
  } else {
    console.error(`❌ Twitter 실패: ${JSON.stringify(data)}`);
    return { ok: false, error: data };
  }
}

// ── LinkedIn 포스팅 ───────────────────────────────────────────────────────────
async function postToLinkedIn(text) {
  const { LINKEDIN_ACCESS_TOKEN, LINKEDIN_PERSON_ID } = process.env;
  const authorUrn = `urn:li:person:${LINKEDIN_PERSON_ID}`;

  const body = {
    author: authorUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: 'NONE',
      },
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
    },
  };

  const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LINKEDIN_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify(body),
  });

  if (res.ok) {
    const data = await res.json();
    console.log(`✅ LinkedIn 발행 완료: ${data.id}`);
    return { ok: true, id: data.id };
  } else {
    const err = await res.text();
    console.error(`❌ LinkedIn 실패 (${res.status}): ${err}`);
    return { ok: false, error: err };
  }
}

// ── Threads 포스팅 ────────────────────────────────────────────────────────────
async function postToThreads(text) {
  const { THREADS_ACCESS_TOKEN: token, THREADS_USER_ID: userId } = process.env;
  const base = 'https://graph.threads.net/v1.0';

  // Step 1: 미디어 컨테이너 생성
  const createRes = await fetch(
    `${base}/${userId}/threads?media_type=TEXT&text=${encodeURIComponent(text)}&access_token=${token}`,
    { method: 'POST' }
  );
  const createData = await createRes.json();

  if (!createData.id) {
    console.error(`❌ Threads 컨테이너 생성 실패: ${JSON.stringify(createData)}`);
    return { ok: false, error: createData };
  }

  // Step 2: 발행
  const publishRes = await fetch(
    `${base}/${userId}/threads_publish?creation_id=${createData.id}&access_token=${token}`,
    { method: 'POST' }
  );
  const publishData = await publishRes.json();

  if (publishRes.ok && publishData.id) {
    console.log(`✅ Threads 발행 완료: ${publishData.id}`);
    return { ok: true, id: publishData.id };
  } else {
    console.error(`❌ Threads 발행 실패: ${JSON.stringify(publishData)}`);
    return { ok: false, error: publishData };
  }
}

// ── 메인 ──────────────────────────────────────────────────────────────────────
async function main() {
  const results = {};

  for (const platform of todayPost.platforms) {
    try {
      if (platform === 'twitter')  results.twitter  = await postToTwitter(todayPost.text);
      if (platform === 'linkedin') results.linkedin = await postToLinkedIn(todayPost.text);
      if (platform === 'threads')  results.threads  = await postToThreads(todayPost.text);
    } catch (e) {
      console.error(`❌ ${platform} 예외 발생:`, e.message);
      results[platform] = { ok: false, error: e.message };
    }
  }

  // 결과 기록
  const idx = schedule.posts.findIndex(p => p.id === todayPost.id);
  schedule.posts[idx].posted = true;
  schedule.posts[idx].postedAt = new Date().toISOString();
  schedule.posts[idx].results = results;

  writeFileSync('./social/schedule.json', JSON.stringify(schedule, null, 2));
  console.log('스케줄 업데이트 완료.');

  // 실패 항목 있으면 exit 1 → GitHub Actions에 경고 표시
  const anyFailed = Object.values(results).some(r => !r.ok);
  if (anyFailed) {
    console.warn('일부 플랫폼 발행 실패. 위 로그 확인.');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
