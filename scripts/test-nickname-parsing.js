const { parseRookieNickname } = require('../src/lib/rookie-points');

console.log('Testing nickname parsing...\n');

const testCases = [
  'testing123 | EU 0/2',
  'testing123 | EU 0/2 1/10',  // The broken case
  '0/2 | wapberry 2/10',  // Test case from the test
  'username 1/2',
  'some name 1.5/2',
  'name | NA 0/2',
  'name | AS 2/2',
  'plainname',
  'name with spaces',
  'wsrlddddddddddddddddddddd | EU 0/2',
];

for (const test of testCases) {
  const result = parseRookieNickname(test);
  console.log(`Input:  "${test}"`);
  console.log(`Base:   "${result.base}"`);
  console.log(`Points: ${result.points}`);
  console.log('');
}
