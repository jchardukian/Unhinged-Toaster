import { test } from 'node:test';
import assert from 'node:assert/strict';
import { americanize, languageGate, UK_SLANG } from '../src/language.js';

test('language gate: observable signals only; universal gags from abroad pass, language-dependent jokes fail', () => {
  assert.deepEqual(languageGate({ speechLanguage: null, speechWords: 0 }), [], 'silent clip');
  assert.deepEqual(languageGate({ speechLanguage: 'english', speechWords: 40, dialogueDependent: true }), [], 'English dialogue');
  assert.deepEqual(languageGate({ speechLanguage: 'hindi', speechWords: 30, dialogueDependent: false, worksMuted: 8 }), [], 'foreign background talk, physical gag works muted');
  assert.match(languageGate({ speechLanguage: 'hindi', speechWords: 30, dialogueDependent: true })[0], /non-English dialogue \(hindi/);
  assert.match(languageGate({ speechLanguage: 'spanish', speechWords: 20, dialogueDependent: false, worksMuted: 3 })[0], /does not work muted/);
  assert.deepEqual(languageGate({ speechLanguage: 'russian', speechWords: 3, dialogueDependent: true }), [], 'a couple of words do not count as dialogue');
  assert.match(languageGate({ speechLanguage: null, speechWords: 0, onscreenTextLanguage: 'other', onscreenTextEssential: true })[0], /on-screen text/);
  assert.deepEqual(languageGate({ speechLanguage: null, speechWords: 0, onscreenTextLanguage: 'other', onscreenTextEssential: false }), [], 'incidental foreign signage is fine');
  assert.match(languageGate({ speechLanguage: null, speechWords: 0, culturalContextNeeded: true })[0], /cultural or regional context/);
});

test('American English: British spellings repaired, slang detected', () => {
  assert.equal(americanize('My favourite colour is grey, mum'), 'My favorite color is gray, mom');
  assert.equal(americanize('HUMOUR'), 'HUMOR');
  assert.equal(americanize('She realised it'), 'She realized it');
  assert.ok(UK_SLANG.test('Cheeky dog nicks the bread, mate'));
  assert.ok(!UK_SLANG.test('This dog has zero chill and I respect it'));
});
