# Node Archive Download server

Experimental Node JS HTTP/Socket IO server to download small to large amount of tar.gz files and unpack these to a specific directory

## Overall

This project features :
*  an HTTP server with socket IO feature
* an async task downloading files with a parameterized simultaneous download value
* cluster separation with on the one hand, the master implementing webserver + async download task and on the other hand the web worker performing the untar + uncompressing pipe task
* a web UI to start the downloading/untar/uncompress processing with user specified list of remote tar.gz url 
* ability to define simultaneous download value, HTTP request timeout for each request, number of attempt for each url

This cluster usage enables separation between process hungry untar/ungzip task from async task + webserver with zero down time

## Architecture

![architecture](img/architecture.png)

## Demo

![demo](img/screen.gif)

## External libraries

* https://github.com/expressjs/body-parser
* https://github.com/marak/colors.js/
* https://github.com/expressjs/express
* https://github.com/mafintosh/gunzip-maybe
* https://github.com/mafintosh/tar-fs
* https://github.com/socketio/socket.io
* https://github.com/codemirror/CodeMirror
* https://jquery.com/

## License

The MIT License (MIT) Copyright (c) 2016 Bertrand Martel




