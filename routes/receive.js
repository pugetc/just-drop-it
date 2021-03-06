/*
 * just-drop-it
 * Copyright (C) 2016 Orange
 * Authors: Benjamin Einaudi  benjamin.einaudi@orange.com
 *          Arnaud Ruffin arnaud.ruffin@orange.com
 *
 * This file is part of just-drop-it.
 *
 * just-drop-it is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with just-drop-it.  If not, see <http://www.gnu.org/licenses/>.
 */

var express = require('express');
var debug = require('debug')('app:routes:receive');
var router = express.Router();
var error = require('debug')('app:routes:receive');

var dao = require("../dao");


router.servePagePath = '/';
router.downloadPath = '/data/';

debug.log = console.log.bind(console);


router.get(router.servePagePath + ':id', function (req, res, next) {
    var uri = req.params.id;
    dao.getSenderFromUri(uri, function (sender) {
        debug('receive - rendering receive for uri %s', uri);
        res.render('receive', {
            isLocal: typeof process.env.OPENSHIFT_NODEJS_IP === "undefined",
            jdropitVersion: global.DROP_IT_VERSION,
            infoMessage : typeof process.env.USER_INFO_MESSAGE === "undefined" ? "" : process.env.USER_INFO_MESSAGE,
            dumbContent : "",
            fileName: sender.fileName,
            fileSize: sender.fileSize,
            senderId: sender.senderId
        });
    }, function () {
        error('receive - file not found %s', uri);
        var err = new Error('Unknown transfer reference');
        err.status = 404;
        err.sub_message = uri;
        next(err);
    });
});


router.get(router.downloadPath + ':id/:receiverId', function (req, res, next) {
    var fileId = req.params.id;
    var receiverId = req.params.receiverId;

    function getNumberOfBytesSent() {
        //req.socket or res.connection
        var socket = req.socket;
        return socket.bytesWritten + socket.bufferSize;
    }

    function encodeFileName(fileName) {
        var result = [];
        for (var cpt = 0; cpt < fileName.length; cpt++) {
            var currentChar = fileName[cpt];
            if ((currentChar >= 'a' && currentChar <= 'z') || (currentChar >= 'A' && currentChar <= 'Z') || (currentChar >= '0' && currentChar <= '9')
                || currentChar == '.' || currentChar == '_' || currentChar == '(' || currentChar == ')' || currentChar == '[' || currentChar == ']' || currentChar == ' ') {
                result.push(currentChar);
            }
        }
        return result.join('');
    }


    dao.getReceiver(fileId, receiverId, function (receiver) {
        debug('download - serving file %s', fileId);
        var initSize = getNumberOfBytesSent();
        var sendDate = false;
        var HEAD_SIZE_WITHOUT_FILE_NAME = sendDate ? 246 : 209;
        var CHECK_SEND_DELAY_IN_MS = 500;
        var TIMEOUT_IN_MS = 60 * 1000;


        //sends header to flush them
        var encodedFileName = encodeFileName(receiver.sender.fileName);
        var headSize = encodedFileName.length + ('' + receiver.sender.fileSize).length + HEAD_SIZE_WITHOUT_FILE_NAME;

        debug("download - init - %d - sent", getNumberOfBytesSent());
        debug("download - file name length - %d", encodedFileName.length);
        debug("download - file size - %d", receiver.sender.fileSize);
        res.sendDate = sendDate;
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': receiver.sender.fileSize,
            'Content-Disposition': 'attachment; filename="' + encodedFileName + '"',
            'Set-Cookie': 'fileDownload=true; path=/'
        });


        receiver.stream.pipe(res);
        function getBodyWritten() {
            return getNumberOfBytesSent() - headSize - initSize;
        }

        var lastNumberOfBytesSent = getBodyWritten();
        var lastPercentSent = 0;
        var numberOfCycleSameSize = 0;
        debug("download - %s  - after head - %d sent", receiverId, getNumberOfBytesSent());

        function sendPercent(percent) {
            if (percent > lastPercentSent) {
                receiver.notifySent(percent);
                lastPercentSent = percent;
            }
        }

        function notifySent() {
            var nbBytesSent = getBodyWritten();
            //Having a NaN here means the interval has not been cleared properly when it should have been
            if(isNaN(nbBytesSent)){
                error("download - %s - task of notification has not been cleared properly", receiverId);
                clearInterval(intervalId);
            }else {
                debug("%s  - running - %d sent", receiverId, nbBytesSent);
                if (nbBytesSent > lastNumberOfBytesSent) {
                    numberOfCycleSameSize = 0;
                    lastNumberOfBytesSent = nbBytesSent;
                    if (nbBytesSent > 0) {
                        var percent = Math.floor((nbBytesSent * 100) / receiver.sender.fileSize);
                        sendPercent(percent);
                    }
                } else if (nbBytesSent == receiver.sender.fileSize || nbBytesSent < receiver.sender.fileSize
                    && ++numberOfCycleSameSize == Math.floor(TIMEOUT_IN_MS / CHECK_SEND_DELAY_IN_MS)) {
                    //download is completed or user is in timeout. Forcing close of response
                    //that will trigger the finish/end event
                    res.end();
                }
            }
        }

        var intervalId = setInterval(notifySent, CHECK_SEND_DELAY_IN_MS);

        receiver.clean = function () {
            clearInterval(intervalId);
            var nbBytesSent = getBodyWritten();
            if (!isNaN(nbBytesSent) && nbBytesSent < receiver.sender.fileSize && res.connection != null) {
                debug("download - closing active download of %s/%s", fileId, receiverId);
                receiver.stream.unpipe(res);
                res.connection.destroy();
            }
            debug("download - %s - end - %d sent", receiverId, isNaN(nbBytesSent) ? "???" : nbBytesSent.toString());
        };


        res.on('finish', function () {
            debug("download - finish - event - %s", receiverId);
            var nbBytesSent = getBodyWritten();
            if (nbBytesSent < receiver.sender.fileSize) {
                error("download - %s - timeout/error", receiverId);
                receiver.timeout();
            } else {
                debug("download - %s - totally sent", receiverId);
                sendPercent(100);
                receiver.completed();
            }
        });
        res.on('close', function () {
            error("download - %s - connection closed by other part", receiverId);
            receiver.disconnected();
        });

    }, function () {
        error('download - file not found or not prepared: %s/%s', fileId, receiverId);
        var err = new Error('Unknown transfer reference');
        err.status = 404;
        err.sub_message = fileId+"/"+receiverId;

        next(err);
    });
});


module.exports = router;