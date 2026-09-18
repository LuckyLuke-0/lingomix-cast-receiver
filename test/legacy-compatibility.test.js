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

test('production page cache-busts current assets and excludes legacy pipelines', function () {
  var html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');

  assert.match(html, /styles\.css\?v=__ASSET_VERSION__/);
  assert.match(html, /receiver-core\.js\?v=__ASSET_VERSION__/);
  assert.match(html, /receiver-trevuxa\.js\?v=__ASSET_VERSION__/);
  assert.doesNotMatch(html, /receiver-v(?:17|21)\.js|mp4box|receiver\.js[?"']/);
});

test('Pages keeps production isolated while publishing an explicitly tagged feature receiver', function () {
  var workflow = fs.readFileSync(
    path.join(projectRoot, '.github', 'workflows', 'pages.yml'),
    'utf8'
  );

  assert.match(workflow, /tags: \[staging-\*\]/);
  assert.match(workflow, /group: pages/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /startsWith\(github\.ref, 'refs\/tags\/staging-'\)/);
  assert.match(workflow, /ref: main\s+path: production/);
  assert.match(workflow, /cp candidate\/receiver-core\.js candidate\/receiver-trevuxa\.js candidate\/styles\.css/);
  assert.match(workflow, /git -C production archive HEAD \| tar -x -C _site/);
  assert.match(workflow, /staging_dir="_site\/staging\/\$\{GITHUB_SHA\}"/);
  assert.match(workflow, /cmp production\/index\.html _site\/index\.html/);
  assert.doesNotMatch(workflow, /cp\s+(?:-r|-R|--recursive)\s+\.\s+_site/);
  assert.doesNotMatch(workflow, /vendor-mp4box/);
});

test('privacy policy is bilingual and discloses mandatory Cast SDK data handling', function () {
  var policy = fs.readFileSync(path.join(projectRoot, 'privacy-policy.html'), 'utf8');

  assert.match(policy, /id="nederlands" lang="nl"/);
  assert.match(policy, /id="english" lang="en"/);
  assert.match(policy, /Google Cast Sender SDK/);
  assert.match(policy, /developers\.google\.com\/cast\/docs\/android_sender\/data_disclosure/);
  assert.match(policy, /GitHub Pages/);
  assert.doesNotMatch(policy, /Notification permission, when requested/);
});

test('terms provide matching Dutch and English sections without a script dependency', function () {
  var terms = fs.readFileSync(path.join(projectRoot, 'terms.html'), 'utf8');
  assert.match(terms, /id="nederlands" lang="nl"/);
  assert.match(terms, /id="english" lang="en"/);
  assert.match(terms, /privacy-policy\.html#nederlands/);
  assert.match(terms, /privacy-policy\.html#english/);
  assert.doesNotMatch(terms, /<script/);
});
