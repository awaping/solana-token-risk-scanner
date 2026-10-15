/**
 * Frontiere de confiance : tout ce qui entre ici vient d'un tiers.
 * `node --test src/listener/normalize.test.ts`
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeTweet } from './normalize.ts';

const ELON = '44196397';

const twitterV2 = {
  data: {
    id: '1234567890',
    text: 'gigachad frog',
    author_id: ELON,
    created_at: '2026-09-17T18:00:00.000Z',
    attachments: { media_keys: ['k1', 'k2'] },
  },
  includes: {
    media: [
      { media_key: 'k1', type: 'photo', url: 'https://pbs.twimg.com/a.jpg' },
      { media_key: 'k2', type: 'video', preview_image_url: 'https://pbs.twimg.com/b.jpg' },
    ],
    users: [{ id: ELON, username: 'elonmusk' }],
  },
};

test('normalise un payload Twitter v2', () => {
  const t = normalizeTweet(twitterV2);
  assert.equal(t?.id, '1234567890');
  assert.equal(t?.authorId, ELON);
  assert.equal(t?.authorHandle, 'elonmusk');
  assert.equal(t?.isRetweet, false);
  assert.equal(t?.isReply, false);
  assert.equal(t?.createdAt, Date.parse('2026-09-17T18:00:00.000Z'));
  // Photo par son url, video par sa vignette.
  assert.deepEqual(t?.imageUrls, ['https://pbs.twimg.com/a.jpg', 'https://pbs.twimg.com/b.jpg']);
});

test('detecte retweets et replies via referenced_tweets', () => {
  const rt = normalizeTweet({
    ...twitterV2,
    data: { ...twitterV2.data, referenced_tweets: [{ type: 'retweeted', id: '1' }] },
  });
  assert.equal(rt?.isRetweet, true);
  const reply = normalizeTweet({
    ...twitterV2,
    data: { ...twitterV2.data, referenced_tweets: [{ type: 'replied_to', id: '1' }] },
  });
  assert.equal(reply?.isReply, true);
});

test('normalise un relais generique aux champs varies', () => {
  const t = normalizeTweet({
    tweet_id: 987,
    full_text: 'hello',
    user_id: ELON,
    screen_name: 'elonmusk',
    timestamp: 1_789_000_000,
    photos: ['https://cdn.invalid/x.png'],
    in_reply_to_status_id: null,
  });
  assert.equal(t?.id, '987');
  assert.equal(t?.text, 'hello');
  assert.equal(t?.authorHandle, 'elonmusk');
  assert.equal(t?.isReply, false);
  assert.deepEqual(t?.imageUrls, ['https://cdn.invalid/x.png']);
});

test('un horodatage en secondes est converti, pas interprete comme des ms', () => {
  // 1789000000 s = 2026. Traite comme des ms, ce serait 1970 et le tweet
  // serait juge perime par le pre-filtre de l'analyzer.
  const t = normalizeTweet({ id: '1', text: 'x', timestamp: 1_789_000_000 });
  assert.equal(t?.createdAt, 1_789_000_000_000);
  // Un horodatage deja en ms passe inchange.
  const ms = normalizeTweet({ id: '1', text: 'x', timestamp: 1_789_000_000_000 });
  assert.equal(ms?.createdAt, 1_789_000_000_000);
});

test('in_reply_to_status_id non nul implique une reponse', () => {
  const t = normalizeTweet({ id: '1', text: 'x', in_reply_to_status_id: '55' });
  assert.equal(t?.isReply, true);
});

test('la whitelist filtre par ID, pas par handle', () => {
  assert.ok(normalizeTweet(twitterV2, { whitelistUserIds: [ELON] }));
  assert.equal(normalizeTweet(twitterV2, { whitelistUserIds: ['999'] }), null);
  // Un handle usurpe avec un autre ID ne passe pas.
  const impostor = {
    ...twitterV2,
    data: { ...twitterV2.data, author_id: '666' },
    includes: { ...twitterV2.includes, users: [{ id: '666', username: 'elonmusk' }] },
  };
  assert.equal(normalizeTweet(impostor, { whitelistUserIds: [ELON] }), null);
});

test('un payload inexploitable renvoie null sans lever', () => {
  for (const junk of [null, undefined, 42, 'ping', {}, { foo: 'bar' }, { id: '1' }, []]) {
    assert.equal(normalizeTweet(junk), null, `should reject ${JSON.stringify(junk)}`);
  }
});

test('les URLs de media non http sont ecartees', () => {
  const t = normalizeTweet({
    id: '1',
    text: 'x',
    images: ['data:image/png;base64,AAA', 'file:///etc/passwd', 'https://ok.invalid/a.png'],
  });
  assert.deepEqual(t?.imageUrls, ['https://ok.invalid/a.png']);
});

test('un texte vide reste un signal valide si des medias sont presents', () => {
  const t = normalizeTweet({ id: '1', text: '', images: ['https://ok.invalid/a.png'] });
  assert.equal(t?.text, '');
  assert.equal(t?.imageUrls.length, 1);
});
