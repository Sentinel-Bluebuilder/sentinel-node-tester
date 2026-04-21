Start-Process -FilePath 'cmd.exe' -ArgumentList '/k',"title Sentinel Audit && cd /d `"$PSScriptRoot`" && node server.js" -Verb RunAs
