const test = require('node:test');
const assert = require('node:assert/strict');

const {
  slugifyLabel,
  isLikelyDirectAudioUrl,
  buildImportedFileName,
  contentTypeToExtension,
} = require('../import-utils.js');

test('slugifyLabel keeps readable lowercase words', () => {
  assert.equal(slugifyLabel('Grand Entrance'), 'grand-entrance');
  assert.equal(slugifyLabel('Father/Daughter'), 'father-daughter');
  assert.equal(slugifyLabel('  Last   Dance  '), 'last-dance');
});

test('isLikelyDirectAudioUrl recognizes common audio links with query strings', () => {
  assert.equal(isLikelyDirectAudioUrl('https://cdn.example.com/intro-track.mp3'), true);
  assert.equal(isLikelyDirectAudioUrl('https://cdn.example.com/intro-track.m4a?download=1'), true);
  assert.equal(isLikelyDirectAudioUrl('https://example.com/watch?v=abc123'), false);
  assert.equal(isLikelyDirectAudioUrl('notaurl'), false);
});

test('contentTypeToExtension maps known audio types and falls back safely', () => {
  assert.equal(contentTypeToExtension('audio/mpeg'), 'mp3');
  assert.equal(contentTypeToExtension('audio/mpeg; charset=binary'), 'mp3');
  assert.equal(contentTypeToExtension('audio/mp4'), 'm4a');
  assert.equal(contentTypeToExtension('audio/wav'), 'wav');
  assert.equal(contentTypeToExtension('application/octet-stream'), 'bin');
});

test('buildImportedFileName prefers cue and event names over remote filenames', () => {
  assert.equal(
    buildImportedFileName({
      cueName: 'Grand Entrance',
      eventName: 'Smith Wedding',
      sourceUrl: 'https://cdn.example.com/uploads/source-file.mp3',
      contentType: 'audio/mpeg',
    }),
    'smith-wedding-grand-entrance.mp3',
  );
});

test('buildImportedFileName falls back to remote filenames when cue name is absent', () => {
  assert.equal(
    buildImportedFileName({
      sourceUrl: 'https://cdn.example.com/audio/party-starter.wav?dl=1',
      contentType: 'audio/wav',
    }),
    'party-starter.wav',
  );
});
