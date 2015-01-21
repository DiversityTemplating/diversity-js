/* global exports */
exports.findComponentsInSettings = function(settings, fn, direction) {
  if (!settings) {
    return;
  }
  var traverse = function(obj) {
    // An object is a component data settings if it has the attribute component  and its a string
    // Top first
    if (direction && obj && obj.component && typeof obj.component === 'string') {
      fn(obj);
    }

    if (Array.isArray(obj)) {
      obj.forEach(traverse);
      return;
    }

    // Lets traverse all properties as well
    if (Object.isObject(obj)) {
      Object.keys(obj).forEach(function(key) {
        traverse(obj[key]);
      });
    }

    // An object is a component data settings if it has the attribute component  and its a string
    // FIXME: should look at schema.
    // Depth first
    if (!direction && obj && obj.component && typeof obj.component === 'string') {
      fn(obj);
    }
  };
  traverse(settings);
};

/**
 * Traverses the dependeny tree of components depth first and
 * applies a function to all steps.
 * @param {Array} names a list of component names that are roots
 * @param {Object} defs object with all diversity.json definitions
 * @param {Function} fn a function to apply
 */
exports.traverseDeps = function(names, defs, fn) {
  names.forEach(function(name) {
    // Let's traverse and apply the apply function on each comp.
    // Depth first.
    var traverse = function(comp) {
      if (comp.done) {
        return;
      }

      fn(comp);
      comp.done = true;
      if (comp.dependencies) {
        Object.keys(comp.dependencies).forEach(function(n) {
          if (defs[n]) {
            traverse(defs[n]);
          }
        });
      }
    };
    traverse(defs[name]);
  });
};

/**
 * Return an object matching defaults of a schema.
 * Defaults on additional properties and array "items" attribute of the type array are not
 * supported.
 * @param {object} schema A JSON Schema that starts with an object.
 * @return {object} an object
 */
var schemaDefaults = function(schema) {
  // Per the json schema spec a "default" can be set on any schema and subschema, this means arrays
  // and objects included.

  var def = function(schema) {
    if (schema.default !== undefined) {
      return schema.default;
    }

    if (schema.properties) {
      var obj = {};
      var empty = true;
      Object.keys(schema.properties).forEach(function(attr) {
        var res = def(schema.properties[attr]);
        if (res !== undefined) {
          obj[attr] = res;
          empty = false;
        }
      });
      return empty ? undefined : obj;
    }
  };

  return def(schema);
};
exports.schemaDefaults = schemaDefaults;

/**
 * Extend an object with defaults from a JSON Schema,
 * schema must start with a "type": "object"
 * @param {object} obj
 * @param {object} schema
 */
exports.mergeWithSchemaDefaults = function(obj, schema) {

  var merge = function(prop, schema) {
    var hasDefault = schema.default !== undefined;

    if (prop === undefined) {
      // Defaults might lie in a deep structure.
      return schemaDefaults(schema);
    } if (Array.isArray(prop)) {
      if (prop.length === 0 && hasDefault) {
        schema.default.forEach(function(item) {
          prop.push(item);
        });
        return prop;

      } else if (schema.items && !Array.isArray(schema.items)) {
        // FIXME: No support for items as array.
        // The array has elements, let's merge them with it's schema.
        prop.forEach(function(item) { merge(item, schema.items); });
        return prop;
      }
    } else if (typeof prop === 'object') {
      // We want it to be an object, not just the boolean that says it can have anything.
      if (schema.additionalProperties && schema.additionalProperties !== true) {
        var properties = schema.properties || {};
        Object.keys(prop).forEach(function(attr) {
          if (!properties[attr]) {
            // Its not defined in properties! Lets merge defaults.
            prop[attr] = merge(prop[attr], schema.additionalProperties);
          }
        });
      }

      if (schema.properties) {
        Object.keys(schema.properties).forEach(function(attr) {
          // Since each attribute might be undefined on the object but do have a default somewhere
          // in the schema we assign the result.
          prop[attr] = merge(prop[attr], schema.properties[attr]);
        });
      }
      return prop;
    }

    // If we get here prop is not undefined, and it's not an object or an array we don't do nothing.
    return prop;
  };

  return merge(obj, schema);
};


/**
 * Deeply merge two objects. Attributes from src will be copied over to dst. Just overwriting
 * values that are defined in src.
 * Arrays are a special case and will be overwritten as if they where a simple value like a string.
 *
 * @param {object} dst Destination object
 * @param {object} src Source object
 * @returns {object} dst object.
 */
var deepMerge = function(dst, src) {
  dst = dst || {};
  src = src || {};

  // We've got a type mixup, so we won't be merging an object over an simple type.
  if (typeof dst !== 'object') {
    return dst;
  }

  Object.keys(src).forEach(function(attr) {
    if (typeof src[attr] === 'object' && !Array.isArray(src[attr])) {
      if (dst[attr]) {
        deepMerge(dst[attr], src[attr]);
      }
      return;
    }

    dst[attr] = src[attr];

  });
  return dst;
};

exports.deepMerge = deepMerge;
