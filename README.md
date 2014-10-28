diversity-js
============

Diversity renderer in javascript. One for the browser, `diversity-renderer.js` and
one for the server, `diversity-server.js`

diversity-server.js
-------------------

### Quick setup

1. clone this repo
1. `npm install`
1. download a json settings file: http://git.diversity.io/shop-themes/aficionado/blob/master/aficionado.json
1. `node diversity-server.js 11011 aficionado.json`


```
Usage:
        node diversity-server.js <webshopid> <themeid|settings.json> [<auth>]
```

The server needs to know which webshop its supposed to serve and what it's settings are. Settings
can either be read from a file (recomended) or from Theme api, if your using the api you need
to supply it with an auth token as well.

The server downloads any components needed under the `deps/` folder.

At every request the will reload the json file and any new components will be cloned. While this is
happening the request might fail, just do a reload.

To issue a git pull on all deps just restart the server or do a request to the magical url `/reset`.
