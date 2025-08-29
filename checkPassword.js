const bcrypt = require('bcrypt');

// Hash stored in your DB for phabade (copied from earlier seed/insert)
const storedHash = '$2b$10$rDZbf.zpAOjWuWYM4BJOfOkcfhp57X2TNrFdlwooLz2w3tjy3bj5K'; 
const plainPassword = 'TLmbtS0@.'; // your login password

bcrypt.compare(plainPassword, storedHash)
  .then(result => console.log('Password match:', result))
  .catch(err => console.error('Error comparing:', err));
