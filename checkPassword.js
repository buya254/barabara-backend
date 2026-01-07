const bcrypt = require('bcrypt');

// Hash stored in your DB for phabade (copied from earlier seed/insert)
const storedHash = '$2b$10$rDZbf.zpAOjWuWYM4BJOfOkcfhp57X2TNrFdlwooLz2w3tjy3bj5K'; 
const plainPassword = 'TLmbtS0@.'; // your login password

const defaultHash = "$2b$10$N72XbJXtKCqcNnyjzRQoO.UU5BdKFx/aZt6fFnPcIBy.PU3mSR6a6"; // from any normal user row
const defaultPlain = "kura@123";

async function run() {
const seedMatch = await bcrypt.compare(plainPassword, storedHash);
  console.log("Seed admin password match:", seedMatch);
const defaultMatch = await bcrypt.compare(defaultPlain, defaultHash);
  console.log("Default user password match:", defaultMatch);
}
 
run().catch(console.error);

