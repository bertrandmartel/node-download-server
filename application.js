/*!
 * dlarchive
 * Copyright(c) 2016 Bertrand Martel
 * MIT Licensed
 */

'use strict';

/**
 * Module dependencies.
 * @private
 */
var http = require("http");
var url = require("url");
var async   = require('async');
var fs = require("fs");
var tar = require('tar-fs');
var gunzip = require('gunzip-maybe');
var colors = require('colors');
var time = require('node-tictoc');

colors.setTheme({
	silly: 'rainbow',
	input: 'grey',
	verbose: 'cyan',
	prompt: 'grey',
	info: 'green',
	data: 'grey',
	help: 'cyan',
	warn: 'yellow',
	debug: 'blue',
	error: 'red'
});

var cluster = require('cluster');

function untar (file,outputDir) {
	file.pipe(gunzip()).pipe(tar.extract(outputDir)).on('error', function(e){
		console.log(colors.error(file.path + " : " + e));
	});
}
 
function originIsAllowed(origin) {
  // put logic here to detect whether the specified origin is allowed. 
  return true;
}
	 

var clusterRemoved = false;
var downloading = false;

var count = 0;
var MAX_RETRY = 2;
var DEFAULT_SIMULTANEOUS_DL = 25;
var DEFAULT_REQUEST_TIMEOUT=5000;
var DEFAULT_DIRECTORY="/tmp";

var retryMap = new Array();

var files = [];

var totalLength = files.length;

function filterDuplicates(){
	var filesNoDuplicate = {};

	for ( var i = 0, len = files.length; i < len; i++ )
	    filesNoDuplicate[files[i]['url']] = files[i];

	files = new Array();
	for ( var key in filesNoDuplicate )
	    files.push(filesNoDuplicate[key]);
}

function log_verbose(data){
	io.sockets.emit('log_verbose', "[" + new Date().toISOString() + "] " + data);
	console.log(colors.verbose("[" + new Date().toISOString() + "] " + data));	
}

function log_error(data){
	io.sockets.emit('log_error', "[" + new Date().toISOString() + "] " + data);
	console.log(colors.error("[" + new Date().toISOString() + "] " + data));	
}

function log_info(data){
	io.sockets.emit('log_info', "[" + new Date().toISOString() + "] " + data);
	console.log(colors.info("[" + new Date().toISOString() + "] " + data));	
}

function retry(list,file,filename){
	var retry;

	if (file.url in retryMap){
		retry =  retryMap[file.url];
	}
	else{
		retry = 1;
	}
	if (retry < MAX_RETRY){
		retryMap[file.url] = retry + 1;
		list.push({url:file.url,outputDirectory:file.outputDirectory});
		log_error("[" + count + "/" + totalLength + "] file " + filename + " failed. Retrying : " + retry + "/" + MAX_RETRY);
		return true;
	}
	else{
		log_error("[" + count + "/" + totalLength + "] file " + filename + " failed. Aborting...");
		return false;
	}
}

function download(files,simultaneousDownload,attemptsNumber,requestTimeout){

	if (attemptsNumber>=0){
		MAX_RETRY = attemptsNumber;
	}

	var requestTimeoutVal = DEFAULT_REQUEST_TIMEOUT;
	if (requestTimeout>0){
		requestTimeoutVal=requestTimeout;
	}

	var simultaneousDl = DEFAULT_SIMULTANEOUS_DL;

	if (simultaneousDownload>=1){
		simultaneousDl = simultaneousDownload;
	}

	downloading=true;

	filterDuplicates();

	totalLength = files.length;
	count = 0;
	
	var worker = cluster.fork();
	
	time.tic();

	worker.on('message', function(message) {
		if (message.type === 'untar'){
			count++;
			log_verbose("[" + count + "/" + totalLength + "] file " + message.data.filename + " was processed successfully");
			if (count == totalLength){
				log_verbose('removing worker');
				clusterRemoved=true;
				time.toc();
				worker.send({type: 'shutdown', from: 'master'});
				downloading=false;
			}
		}
		else if (message.type === 'untar_fail'){
			log_error("[" + count + "/" + totalLength + "] file " + message.data.filename + " failed : " + message.error + ". Retrying...");
			files.push({url:message.data.filename,outputDirectory:message.data.outputDir});
		}
	});

	cluster.on('online', function(worker) {

		log_info('Worker ' + worker.process.pid + ' is online');

		async.eachLimit(files
			,simultaneousDl, function(file, callback) {

			try {
				var filename = url.parse(file.url).pathname.split("/").pop();

				var options = {
				  host: url.parse(file.url).hostname,
				  path: url.parse(file.url).pathname,
				  method: 'GET'
				};

				var listener = function (response) {

					var downloadfile = fs.createWriteStream(DEFAULT_DIRECTORY + "/" + filename, {'flags': 'w'});
					
					response.on('data', function (chunk) {
						downloadfile.write(chunk, { 'encoding':'binary'});
					});

					response.on("end", function() {
						downloadfile.end();
						
						if (!clusterRemoved){
							worker.send({
								type: 'untar',
								from: 'master',
								data: {
									filename: DEFAULT_DIRECTORY + "/" + filename,
									outputDir: file.outputDirectory
								}
							});
						}
						callback();
					});

					response.on("error", function(err) {
						log_error("response error " + err);
					});

				};
				var req = http.request(options, listener);

				req.on('error', function (e) {

					var isRetry = retry(files,file,filename);
					if (!isRetry){
						count++;
						if (count == totalLength){
							log_verbose('removing worker');
							time.toc();
							if (!clusterRemoved){
								clusterRemoved = true;
								worker.send({type: 'shutdown', from: 'master'});
							}
							downloading=false;
						}
					}
					callback();
				});

				req.on('timeout', function () {
					log_error('timeout');
					req.abort();
				});

				req.setTimeout(requestTimeoutVal);

				req.end();

			} catch (ex) {
				log_error(ex);
				fs.appendFile('errors.txt', 'async task failure : ' + ex, function (err) {
					callback();
				});
			}

		}, function(err){
			if (err){
				log_error(err);
			}
			else{
				log_info("finished downloading " + totalLength + " files.");
			}
			
		}); 

	});
};

if(cluster.isMaster) {
	
	var express = require('express'), app = express();
	var http = require('http')
  , server = http.createServer(app)
  , io = require('socket.io').listen(server);

	var bodyParser = require('body-parser');

	app.use(bodyParser.urlencoded({
    	extended: true
	}));
	app.use(bodyParser.json());


	app.post('/startDownload', function(req, res) {
		log_verbose("api called : startDownload")
		if (!downloading) {
			try {
				var fileJson = JSON.parse(req.body.files);
				var simultaneousDownload = req.body.simultaneous_download;
				var attemptsNumber = req.body.attempts_number;
				var requestTimeout = req.body.requestTimeout;
				if (fileJson instanceof Array){
					download(fileJson,simultaneousDownload,attemptsNumber,requestTimeout);
				}
				else{
					log_error("invalid json format");
					res.sendStatus(500);
					return;
				}
				res.sendStatus(200);
			} catch (e) {
				log_error("invalid json format");
			   res.sendStatus(500);
			}
		}
		else {
			log_error("already downloading...");
			res.sendStatus(500);
		}
	});

	/*
    var server = app.listen(8000, function() {
        console.log('Process ' + process.pid + ' is listening to all incoming requests');
    });
	*/
    app.use("/", express.static(__dirname + '/'));

	server.listen(8000,  function() {
		log_info('Process ' + process.pid + ' is listening to all incoming requests')
    });

	log_info("Server listening on port " + 8000);

    io.sockets.on('connection', function (socket) { // First connection

    	log_verbose("client has connected");

		socket.on('message', function (data) { // Broadcast the message to all
			log_verbose("new message : " + data);
				/*
				var transmit = {date : new Date().toISOString(), pseudo : socket.nickname, message : data};
				socket.broadcast.emit('message', transmit);
				console.log("user "+ transmit['pseudo'] +" said \""+data+"\"");
				*/
		});
		socket.on('disconnect', function () { // Disconnection of the client
			log_verbose("client has disconnected");
			/*
			users -= 1;
			reloadUsers();
			if (pseudoSet(socket))
			{
				console.log("disconnect...");
				var pseudo;
				pseudo = socket.nickname;
				var index = pseudoArray.indexOf(pseudo);
				pseudo.slice(index - 1, 1);
			}
			*/
		});
	});

}
else {
	process.on('message', function(message) {
		if(message.type === 'untar') {
			var file = fs.createReadStream(message.data.filename);
			file.on('error', function(err) {
				process.send({
					type:'untar_fail',
					from: 'Worker ' + process.pid,
					data: {
						filename: message.data.filename,
						outputDir: message.data.outputDirectory,
						error : "" + err
					}
				});
			});
			file.on('end', function() {
				fs.unlink(message.data.filename, function() {
					process.send({
						type:'untar',
						from: 'Worker ' + process.pid,
						data: message.data
					});
				});
			});
			untar(file,message.data.outputDir);
		}
		else if(message.type === 'shutdown') {
			downloading=false;
			process.exit(0);
		}
	});
}