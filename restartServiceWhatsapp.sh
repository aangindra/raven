#!/bin/bash
git checkout .
git pull --no-edit
yarn

dirs=($(find ../ -maxdepth 1 -type d -path ./dist -prune -o -printf '%P\n' | sort -t '\0' -n))
#echo $dirs
for i in "${dirs[@]}"
do
  printf "=============================> RELOADING SERVICES %s <=============================\n " "'${i}'"
  cd ../${i}
  pwd
  git checkout .
  git pull --no-edit
done

# Flush pm2 logs
pm2 flush
pm2 reset all