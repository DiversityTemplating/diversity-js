diversity-js
============

Diversity renderer in javascript. One for the browser, `diversity-renderer.js` and
one for the server, `diversity-server.js`

diversity-server.js
-------------------

`diversity-server.js` is meant to ease development of components and themes.

### Quick setup

1. clone this repo
1. `npm install`
1. download a json settings file: http://git.diversity.io/shop-themes/aficionado/blob/master/aficionado.json
1. `node diversity-server.js 11011 aficionado`


```
Usage:
        node diversity-server.js <webshopid> <themeid|theme-name> [<auth>]
```
The server needs a webshop uid and either a theme id (to be used with Theme.get) or the name of the
theme component to use. In that case it will use the defaults from the settings schema of the
component for the settings data. If the a theme id is used and but it isn't active you also need
a auth key to access it.

The server downloads any components needed under the `deps/` folder. It does this at the first
request and it can take quite some time.

To issue a git pull on all deps just restart the server or do a request to the magical url `/reset`.

When developing just symlink your component into the deps folder, this can also be done with
components that doesn't even have a repo yet.

### CAVEATS
  * Translation support isn't implemented
  * The latest version of a component will always be used, to "downgrade" manually checkout a tag
