var express = require('express');
var debug = require('debug')('app:routes:receive');
var router = express.Router();
var error = require('debug')('app:routes:receive');

var dao = require("../dao");


router.servePagePath = '/';
router.downloadPath = '/data/';

debug.log = console.log.bind(console);


router.get(router.servePagePath + ':id', function (req, res, next) {
    var fileId = req.params.id;
    dao.getSender(fileId, function (sender) {
        debug('receive - rendering receive for file %s', fileId);
        res.render('receive', {
            title: "Just drop it",
            isLocal: typeof process.env.OPENSHIFT_NODEJS_IP === "undefined",
            fileName: sender.fileName,
            fileSize: sender.fileSize,
            jdropitVersion: global.DROP_IT_VERSION,
            senderId: fileId,
            receiverLabel: req.cookies['CTI']
        });
    }, function () {
        error('receive - file not found %s', fileId);
        var err = new Error('Not Found');
        err.status = 404;
        next(err);
    });
});


router.get(router.downloadPath + ':id/:receiverId', function (req, res, next) {
    var fileId = req.params.id;
    var receiverId = req.params.receiverId;

    function getNumberOfBytesSent() {
        //req.socket or res.connection
        var socket =req.socket;
        debug("getNumberOfBytesSent - %d - %d", socket.bufferSize, socket.bytesWritten);
        return socket.bytesWritten + socket.bufferSize;
    }



    dao.getReceiver(fileId, receiverId, function (receiver) {
        debug('download - serving file %s', fileId);
        var initSize = getNumberOfBytesSent();

        var HEAD_SIZE_WITHOUT_FILE_NAME = 253;

        //sends header to flush them
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': receiver.sender.fileSize,
            'Content-Disposition': 'attachment; filename="' + receiver.sender.fileName + '"',
            'Set-Cookie': 'fileDownload=true; path=/'
        });


        var headSize = receiver.sender.fileName.length + HEAD_SIZE_WITHOUT_FILE_NAME;

        receiver.stream.pipe(res);
        var intervalId = setInterval(function () {
            receiver.notifySent(getNumberOfBytesSent() - headSize - initSize);
        }, 100);
        res.on('finish', function () {
            debug("finished");
            receiver.notifyFinished();
        });
        receiver.clean = function () {
            if (res.connection != null) {
                debug("closing active download of %s/%s", fileId, receiverId);
                receiver.stream.unpipe(res);
                res.connection.destroy();
            }
            clearInterval(intervalId);
        };
        res.connection.write('', 'utf8', function(){

        });


    }, function () {
        error('download - file not found or not prepared: %s/%s', fileId, receiverId);
        var err = new Error('Not Found');
        err.status = 404;
        next(err);
    });
});


module.exports = router;