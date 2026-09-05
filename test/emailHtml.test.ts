import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExdoxEmailHtml } from '../src/aws/shared/emailHtml.js';

test('action emails render the full encoded HTTPS URL as one clickable link', () => {
  const url = 'https://exdox.co.uk/register?inviteToken=abc123&email=person%40example.com';
  const html = buildExdoxEmailHtml({
    heading: 'Join Exdox',
    paragraphs: ['Accept your invitation.'],
    action: { label: 'Accept invitation', url },
  });

  const escapedUrl = 'https://exdox.co.uk/register?inviteToken=abc123&amp;email=person%40example.com';
  assert.ok(html.includes(`href="${escapedUrl}"`));
  assert.ok(html.includes(`>${escapedUrl}</a>`));
});

test('plain HTTPS URLs are linkified without including sentence punctuation', () => {
  const html = buildExdoxEmailHtml({
    heading: 'Your update',
    paragraphs: ['Open https://exdox.co.uk/claims.'],
  });

  assert.ok(html.includes('href="https://exdox.co.uk/claims"'));
  assert.ok(html.includes('>https://exdox.co.uk/claims</a>.'));
});

test('custom app schemes are not emitted as clickable email actions', () => {
  const html = buildExdoxEmailHtml({
    heading: 'Join Exdox',
    paragraphs: ['Accept your invitation.'],
    action: { label: 'Accept invitation', url: 'exdox://signup?inviteToken=abc123' },
  });

  assert.ok(html.includes('href="#"'));
  assert.ok(!html.includes('href="exdox://'));
});
