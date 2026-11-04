// Usage: npm run hash-password -- 'your-password'
const bcrypt = require('bcryptjs');

const pw = process.argv[2];
if (!pw || pw.length < 10) {
  console.error('Usage: npm run hash-password -- "<password, min 10 chars>"');
  process.exit(1);
}
console.log(bcrypt.hashSync(pw, 12));
