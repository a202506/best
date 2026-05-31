rmdir /s /q ".git"
git init -b "main"
git config user.name  a202506
git config user.email a202506@unknown.com
git add .
git commit -m "."

git remote add origin git@github.com:a202506/best.git
git push -u --force origin main

rmdir /s /q ".git"