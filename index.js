/*** ImportTelldusLive module *******************************************
 
 Version: 1.0.3
 -----------------------------------------------------------------------------
 Author: Ruben Andreassen <rubean85@gmail.com>
 Description:
 Imports devices and sensors from Telldus Live
 ******************************************************************************/

function ImportTelldusLive(id, controller) {
    // Always call superconstructor first
    ImportTelldusLive.super_.call(this, id, controller);

    // Perform internal structures initialization...
}

inherits(ImportTelldusLive, AutomationModule);

_module = ImportTelldusLive;

ImportTelldusLive.prototype.init = function (config) {
    // Always call superclass' init first
    ImportTelldusLive.super_.prototype.init.call(this, config);

    executeFile(this.moduleBasePath() + "/ext/hmac-sha1.js");
    executeFile(this.moduleBasePath() + "/ext/enc-base64-min.js");
    executeFile(this.moduleBasePath() + "/ext/oauth-1.0a.js");

    this.urlPrefix = this.config.url;
    this.dT = Math.max(this.config.dT, 500); // 500 ms minimal delay between requests
    this.sT = Math.max(this.config.sT, 30000); // 30000 ms minimal delay between requests for sensors
    this.urlEmonCMSPrefix = this.config.urlEmonCMS;
    this.apiKeyEmonCMS = this.config.apiKeyEmonCMS;
    this.lastRequestD = 0;
    this.lastRequestS = 0;
    this.timerD = null; //Device Timer
    this.timerS = null; //Sensor Timer
    this.alwaysSyncTitlesFromTelldus = this.config.alwaysSyncTitlesFromTelldus;

    //Init oAuth
    this.oauth = OAuth({
        consumer: {
            key: this.config.publicKey,
            secret: this.config.privateKey
        },
        signature_method: 'HMAC-SHA1',
        hash_function: function (base_string, key) {
            return CryptoJS.HmacSHA1(base_string, key).toString(CryptoJS.enc.Base64);
        }
    });
    //Token
    this.token = {
        key: this.config.token,
        secret: this.config.tokenSecret
    };

    this.requestDeviceUpdate();
    this.requestSensorUpdate();
};

ImportTelldusLive.prototype.stop = function () {
    var self = this;

    if (this.timerD) {
        clearTimeout(this.timerD);
    }
    if (this.timerS) {
        clearTimeout(this.timerS);
    }

    this.controller.devices.filter(function (xDev) {
        return (xDev.id.indexOf("TL_" + self.id + "_") !== -1);
    }).map(function (yDev) {
        return yDev.id;
    }).forEach(function (item) {
        self.controller.devices.remove(item);
    });

    ImportTelldusLive.super_.prototype.stop.call(this);
};


// ----------------------------------------------------------------------------
// --- Module methods
// ----------------------------------------------------------------------------

ImportTelldusLive.prototype.requestDeviceUpdate = function () {
    var self = this;

    this.lastRequestD = Date.now();

    try {
        //Request data
        var request_data = {
            url: this.urlPrefix + "/json/devices/list?supportedMethods=19&includeIgnored=0",
            method: 'GET'
        };

        http.request({
            url: request_data.url,
            method: request_data.method,
            headers: this.oauth.toHeader(this.oauth.authorize(request_data, this.token)),
            async: true,
            success: function (response) {
                self.parseDeviceResponse(response);
            },
            error: function (response) {
                console.log("Can not make request (requestDeviceUpdate): " + response.statusText); // don't add it to notifications, since it will fill all the notifcations on error
                if (response.status === -1) {
                    console.log("Retry requestDeviceUpdate");
                    self.requestDeviceUpdate();
                }
            },
            complete: function () {
                var dt = self.lastRequestD + self.dT - Date.now();
                if (dt < 0) {
                    dt = 1; // in 1 ms not to make recursion
                }

                if (self.timerD) {
                    clearTimeout(self.timerD);
                }

                self.timerD = setTimeout(function () {
                    self.requestDeviceUpdate();
                }, dt);
            }
        });
    } catch (e) {
        console.log("ERROR perfoming request!");
        console.log(e.name);
        console.log(e.message);
        self.timerD = setTimeout(function () {
            self.requestDeviceUpdate();
        }, self.dT);
    }
};

ImportTelldusLive.prototype.parseDeviceResponse = function (response) {
    var self = this;

    if (response.status === 200 && response.contentType === "application/json") {
        var data = response.data;

        data.device.forEach(function (item) {
            var localId = "TL_" + self.id + "_" + item.id,
                    vDev = self.controller.devices.get(localId);

            var level = "off";
            switch (parseInt(item.state, 10)) {
                case 1: //ON
                    level = "on";
                    break;
                case 2: //OFF
                    level = "off";
                    break;
                case 16: //ON Dim
                    //Konverting from the scale from 0-255 to 0-99
                    level = (item.statevalue === null) ? 0 : Math.round((parseInt(item.statevalue, 10) / 255) * 99);
                    if (isNaN(level)) {
                        level = 0;
                    }
                    break;
            }

            var deviceType = (item.methods === 19) ? "switchMultilevel" : "switchBinary";
            var probeTitle = (item.methods === 19) ? "Multilevel" : "Binary";
            var icon = (item.methods === 19) ? "multilevel" : "switch";

            if (vDev) {
                if (self.alwaysSyncTitlesFromTelldus) {
                    vDev.set("metrics:title", "TL " + item.name); //Update title
                }

                if (vDev.get("metrics:level") !== level) { //Only change if the level if different (or triggers will go haywire)
                    vDev.set("metrics:level", level);
                }
            } else if (!self.skipDevice(localId)) {
                self.controller.devices.create({
                    deviceId: localId,
                    defaults: {
                        deviceType: deviceType,
                        metrics: {
                            probeTitle: probeTitle,
                            level: level,
                            title: "TL " + item.name,
                            icon: icon
                        }
                    },
                    overlay: {},
                    handler: function (command, args) {
                        self.handleDeviceCommand(this, command, args);
                    },
                    moduleId: this.id
                });

                self.renderDevice({deviceId: localId, deviceType: deviceType});
            }
        });
    }
};

ImportTelldusLive.prototype.handleDeviceCommand = function (vDev, command, args) {
    var self = this;

    var remoteId = vDev.id.slice(("TL_" + this.id + "_").length);

    var level = command;
    var url = "";
    switch (command) {
        case "update":
            remoteId = remoteId.slice(0, -1);
            url = this.urlPrefix + '/json/sensor/info?id=' + remoteId;
            break;
        case "on":
            url = this.urlPrefix + '/json/device/command?id=' + remoteId + '&method=1';
            break;
        case "off":
            url = this.urlPrefix + '/json/device/command?id=' + remoteId + '&method=2';
            break;
        case "exact":
            level = args.level;
            url = this.urlPrefix + '/json/device/command?id=' + remoteId + '&method=16&value=' + Math.round((level / 99) * 255);
            break;
        default:
            return;
    }

    try {
        //Request data
        var request_data = {
            url: url,
            method: 'GET'
        };

        http.request({
            url: request_data.url,
            method: request_data.method,
            headers: this.oauth.toHeader(this.oauth.authorize(request_data, this.token)),
            async: true,
            success: function (response) {
                if (response.status === 200 && response.contentType === "application/json") {
                    var data = response.data;
                    console.log(data.id);
                    console.log(remoteId);
                    //Device response
                    if (data.status !== undefined && data.status === "success") {
                        vDev.set("metrics:level", level);
                    }
                    //Sensor response
                    else if (data.id !== undefined && data.id === remoteId) {
                        response.data = {
                            sensor: [
                                data
                            ]
                        };
                        self.parseSensorResponse(response);
                    } else {
                        console.log("Unknown or error response (handleDeviceCommand)");
                    }
                }
            },
            error: function (response) {
                console.log("Can not make request (handleDeviceCommand): " + response.statusText);
                if (response.status === -1) {
                    console.log("Retry handleDeviceCommand");
                    self.handleDeviceCommand(vDev, command, args);
                }
            },
            complete: function () {
            }
        });
    } catch (e) {
        console.log("ERROR perfoming request!");
    }
};

ImportTelldusLive.prototype.logSensorValue = function (vDev) {
    var self = this;
    //Log values to EmonCMS if URL and API Key is provided
    if (this.urlEmonCMSPrefix.length === 0 || this.apiKeyEmonCMS.length === 0) {
        return;
    }
    try {
        var remoteId = vDev.id.slice(("TL_" + this.id + "_").length);
        var url = this.urlEmonCMSPrefix + "/input/post.json?time=" + vDev.get("updateTime") + "&node=" + remoteId.slice(0, -1) + "&json={%22" + vDev.get("metrics:icon") + "%22:%22" + vDev.get("metrics:level") + "%22}&apikey=" + this.apiKeyEmonCMS;
        //console.log("Logging sensor value " + url);
        http.request({
            url: url,
            method: "GET",
            async: true,
            success: function (response) {
                //console.log("response status "+response.data.success+" message: "+response.data.message);
            },
            error: function (response) {
                console.log("Can not make request (logSensorValue): " + response.statusText);
                if (response.status === -1) {
                    console.log("Retry logSensorValue");
                    self.logSensorValue(vDev);
                }
            },
            complete: function () {
            }
        });
    } catch (e) {
        //Probably error in one of vDev.get
    }
};

ImportTelldusLive.prototype.skipDevice = function (id) {
    var skip = false;

    this.config.skipDevices.forEach(function (skipItem) {
        if (skipItem === id) {
            skip |= true;
            return false; // break
        }
    });

    return skip;
};

ImportTelldusLive.prototype.renderDevice = function (obj) {
    var skip = false;

    this.config.renderDevices.forEach(function (deviceObj) {
        if (deviceObj.deviceId === obj.deviceId) {
            skip |= true;
            return false; // break
        }
    });

    if (!skip) {
        this.config.renderDevices.push(obj);
        this.saveConfig();
    }
};

ImportTelldusLive.prototype.requestSensorUpdate = function () {
    var self = this;

    this.lastRequestS = Date.now();

    try {
        //Request data
        var request_data = {
            url: this.urlPrefix + '/json/sensors/list?includeValues=1&includeIgnored=0&includeScale=1',
            method: 'GET'
        };

        http.request({
            url: request_data.url,
            method: request_data.method,
            headers: this.oauth.toHeader(this.oauth.authorize(request_data, this.token)),
            async: true,
            success: function (response) {
                self.parseSensorResponse(response);
            },
            error: function (response) {
                console.log("Can not make request (requestSensorUpdate): " + response.statusText);
                if (response.status === -1) {
                    console.log("Retry requestSensorUpdate");
                    self.requestSensorUpdate();
                }
            },
            complete: function () {
                var dt = self.lastRequestS + self.sT - Date.now();
                if (dt < 0) {
                    dt = 1; // in 1 ms not to make recursion
                }

                if (self.timerS) {
                    clearTimeout(self.timerS);
                }

                self.timerS = setTimeout(function () {
                    self.requestSensorUpdate();
                }, dt);
            }
        });
    } catch (e) {
        self.timerS = setTimeout(function () {
            self.requestSensorUpdate();
        }, self.sT);
    }
};


ImportTelldusLive.prototype.parseSensorResponse = function (response) {
    var self = this;

    if (response.status === 200, response.contentType === "application/json") {
        var data = response.data;

        data.sensor.forEach(function (item) {
            var subId = 0;
            item.data.forEach(function (sensorData) {
                var localId = "TL_" + self.id + "_" + item.id + "" + subId,
                        vDev = self.controller.devices.get(localId);

                if (vDev) {
                    if (self.alwaysSyncTitlesFromTelldus) {
                        vDev.set("metrics:title", "TL " + item.name + " " + sensorData.name); //Update title
                    }
        
                    vDev.set("updateTime", sensorData.lastUpdated);
                    if (vDev.get("metrics:level") !== sensorData.value) { //Only change if the level if different (or triggers will go haywire)
                        vDev.set("metrics:level", sensorData.value);
                    }
                } else if (!self.skipDevice(localId)) {
                    var icon = (sensorData.name === "temp") ? "temperature" : "humidity";
                    var scaleTitle = (sensorData.name === "temp") ? "°C" : "%";

                    self.controller.devices.create({
                        deviceId: localId,
                        defaults: {
                            deviceType: "sensorMultilevel",
                            metrics: {
                                probeTitle: item.model,
                                level: sensorData.value,
                                title: "TL " + item.name + " " + sensorData.name,
                                icon: icon,
                                scaleTitle: scaleTitle
                            }
                        },
                        overlay: {},
                        handler: function (command, args) {
                            self.handleDeviceCommand(this, command, args);
                        },
                        moduleId: this.id,
                        probeType: icon,
                        updateTime: item.lastUpdated
                    });

                    self.renderDevice({deviceId: localId, deviceType: "sensorMultilevel"});
                }
                self.logSensorValue(vDev);
                subId++;
            });
        });
    }
};
