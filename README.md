# ImportTelldusLive
Imports devices and sensors from Telldus Live! to Z-Way

# Installation
The easyest way is to add a token in your Z-Way Web Interface.

Go to Management -> App Store Access and add the token `link_telldus_live`

The app will be awailable for download in Apps -> Online Apps in the group Ext. Devices/Services

Alternative you can clone this repository directly on your server

```bash
$  cd /opt/z-way-server/automation/modules/
$ git clone https://github.com/xibriz/ImportTelldusLive.git
$ sudo service z-way-server restart
```

#Setup
You need to get some keys to use the Telldus Live! API

Go to https://api.telldus.com/ and log in. Then select `Your keys` in the menu and then `Generate a private token for my user only`

You need to write down the Public Key, Private Key, Token and Token Secret to use when you install the App in Z-Way