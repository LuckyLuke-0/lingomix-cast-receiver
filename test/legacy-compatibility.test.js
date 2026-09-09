'use strict';

var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var test = require('node:test');

var projectRoot = path.resolve(__dirname, '..');
var productionFiles = ['receiver-core.js', 'receiver-trevuxa.js'];

test('production receiver JavaScript stays within the legacy ES5 subset', function () {
  var forbidden = [
    ['arrow function', /=>/],
    ['block-scoped declaration', /\b(?:const|let)\s+/],
    ['class declaration', /\bclass\s+/],
    ['async or await', /\b(?:async|await)\b/],
    ['optional chaining', /\?\./],
    ['nullish coalescing', /\?\?/],
    ['spread or rest syntax', /\.\.\.\s*[A-Za-z_$]/],
    ['for-of loop', /for\s*\([^)]*\bof\b/],
    ['fetch API', /\bfetch\s*\(/],
    ['new collection API', /\b(?:Map|Set|Symbol)\s*\(/],
    ['modern static helper', /(?:Array\.from|Object\.assign|Number\.isFinite|Number\.isNaN)\s*\(/],
    ['modern prototype helper', /\.(?:includes|startsWith|endsWith|padStart|padEnd|find|findIndex)\s*\(/]
  ];

  productionFiles.forEach(function (fileName) {
    var source = fs.readFileSync(path.join(projectRoot, fileName), 'utf8');
    forbidden.forEach(function (rule) {
      assert.doesNotMatch(source, rule[1], fileName + ' contains ' + rule[0]);
    });
  });
});

test('subtitle styling has non-variable fallbacks for old Chromecast browsers', function () {
  var css = fs.readFileSync(path.join(projectRoot, 'styles.css'), 'utf8');
  var receiver = fs.readFileSync(path.join(projectRoot, 'receiver-trevuxa.js'), 'utf8');

  assert.match(css, /bottom:\s*4%;\s*\n\s*bottom:\s*var\(/);
  assert.match(css, /color:\s*#fff;\s*\n\s*color:\s*var\(/);
  assert.match(css, /font-size:\s*44px;\s*\n\s*font-size:\s*clamp\(/);
  assert.match(receiver, /subtitle\.style\.fontSize\s*=/);
  assert.match(receiver, /subtitle\.style\.textShadow\s*=/);
});
