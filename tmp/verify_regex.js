const testMessages = [
  "Error at 0xDEADBEEF: Invalid state",
  "User 123456789012345678 joined guild 987654321098765432",
  "Transaction 500 failed for amount 100",
  "Database error: 550e8400-e29b-411d-a716-446655440000 not found",
  "Multiple issues: 0x123 and 0x456 observed",
];

function normalizeMessage(message) {
  if (!message) return '';
  return String(message)
    .replace(/\b\d{17,20}\b/g, '[ID]') 
    .replace(/0x[a-fA-F0-9]+/g, '[HEX]') 
    .replace(/\b\d+\b/g, '[NUM]') 
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[UUID]') 
    .trim();
}

console.log("--- REGEX VERIFICATION ---");
testMessages.forEach(msg => {
  console.log(`Original:  ${msg}`);
  console.log(`Normalized: ${normalizeMessage(msg)}`);
  console.log('---');
});
