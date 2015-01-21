
var chai = require('chai').should();
var expect = chai.expect;

describe('util module', function() {

  var util = require('./lib/util.js');

  describe('schemaDefaults', function() {

    it('should give defaults of simple object', function() {
      var res = util.schemaDefaults({
        type: 'object',
        properties: {
          foo: {
            type: 'string',
            'default': 'foobar'
          }
        }
      });

      res.should.deep.eq({foo: 'foobar'});

    });

    it('should give defaults of simple string', function() {
      var res = util.schemaDefaults({
        type: 'string',
        'default': 'foobar'
      });

      res.should.deep.eq('foobar');
    });

    it('should give defaults of simple boolean', function() {
      var res = util.schemaDefaults({
        type: 'boolean',
        'default': false
      });

      res.should.eq(false);
    });

    it('should give defaults of simple boolean that is true', function() {
      var res = util.schemaDefaults({
        type: 'boolean',
        'default': true
      });

      res.should.eq(true);
    });

    it('should give defaults of simple number', function() {
      var res = util.schemaDefaults({
        type: 'number',
        'default': 0
      });

      res.should.eq(0);
    });

    it('should give defaults of simple number greater than 0', function() {
      var res = util.schemaDefaults({
        type: 'number',
        'default': 10
      });

      res.should.eq(10);
    });

    it('should give defaults of an array', function() {
      var res = util.schemaDefaults({
        type: 'array',
        items: {type:'string'},
        'default': ['foo', 'bar']
      });

      res.should.deep.eq(['foo', 'bar']);
    });

    it('should default on objects, ignoring deeper defaults', function() {
      var res = util.schemaDefaults({
        type: 'object',
        properties: {
          foo: {
            type: 'string',
            'default': 'foobar'
          }
        },
        'default': {
          foo: 'bar'
        }
      });

      res.should.deep.eq({foo: 'bar'});

    });

    it('should handle deeply nested objects', function() {
      var res = util.schemaDefaults({
        type: 'object',
        properties: {
          foo: {
            type: 'string',
            'default': 'foobar'
          },
          bar: {
            type: 'object',
            properties: {
              baz: {
                type: 'object',
                properties: {
                  zeb: {
                    type: 'boolean',
                    'default': false
                  },
                  nono: {
                    type: 'boolean'
                  }
                }
              }
            }
          }
        }
      });

      res.should.deep.eq({foo: 'foobar', bar: {baz: {zeb: false}}});

    });

    it('should not create empty objects', function() {
      var res = util.schemaDefaults({
        type: 'object',
        properties: {
          foo: {
            type: 'string',
            'default': 'foobar'
          },
          bar: {
            type: 'object',
            properties: {
              baz: {
                type: 'object',
                properties: {
                  zeb: {
                    type: 'boolean',
                  },
                  nono: {
                    type: 'boolean'
                  }
                }
              }
            }
          }
        }
      });

      res.should.deep.eq({foo: 'foobar'});
    });

  });

  describe('mergeWithSchemaDefaults', function() {

    it('should merge the defaults from a schema with the an actual object', function() {

      var res = util.mergeWithSchemaDefaults(
        {foo: 'foobar'},
        {
          type: 'object',
          properties: {
            foo: {type: 'string'},
            bar: {
              type: 'string',
              'default': 'bar'
            }
          }
        }
      );

      res.should.deep.eq({
        foo: 'foobar',
        bar: 'bar'
      });
    });

    it('should merge the defaults from a schema with the an actual object even if schema does not match', function() {

      var res = util.mergeWithSchemaDefaults(
        {foo: 'foobar'},
        {
          type: 'object',
          properties: {
            bar: {
              type: 'string',
              'default': 'bar'
            }
          }
        }
      );

      res.should.deep.eq({
        foo: 'foobar',
        bar: 'bar'
      });
    });

    it('should not overwrite existing properties', function() {

      var res = util.mergeWithSchemaDefaults(
        {foo: 'foobar'},
        {
          type: 'object',
          properties: {
            foo: {
              type: 'string',
              'default': 'bar'
            }
          }
        }
      );

      res.should.deep.eq({
        foo: 'foobar'
      });
    });

    it('should merge deeply nested properties', function() {

      var res = util.mergeWithSchemaDefaults(
        {foo: 'foobar', bar: { baz: { }, bazz: true}},
        {
          type: 'object',
          properties: {
            bar: {
              type: 'object',
              properties: {
                baz: {
                  type: 'object',
                  properties: {
                    zeb: {
                      type: 'boolean',
                      'default': false
                    }
                  }
                }
              }
            }
          }
        }
      );

      res.should.deep.eq({foo: 'foobar', bar: { baz: { zeb: false }, bazz: true}});
    });

    it('should merge deeply nested properties even if they are not present in obj', function() {

      var res = util.mergeWithSchemaDefaults(
        {foo: 'foobar'},
        {
          type: 'object',
          properties: {
            bar: {
              type: 'object',
              properties: {
                baz: {
                  type: 'object',
                  properties: {
                    zeb: {
                      type: 'boolean',
                      'default': false
                    }
                  }
                }
              }
            }
          }
        }
      );

      res.should.deep.eq({foo: 'foobar', bar: { baz: { zeb: false }}});
    });

    it('should honor additionalProperties', function() {

      var res = util.mergeWithSchemaDefaults(
        {foo: 'foobar', baz: {one: 0}, zeb: {two:10}, bar:{}},
        {
          type: 'object',
          properties: {
            foo: {
              type: 'string'
            }
          },
          additionalProperties: {
            type: 'object',
            properties: {
              one: {type: 'number', 'default': 1},
              two: {type: 'number', 'default': 2}
            }
          }
        }
      );

      res.should.deep.eq({
        foo: 'foobar',
        baz: {one: 0, two: 2},
        zeb: {one: 1, two: 10},
        bar:{one: 1, two: 2}
      });
    });

    it('should honor defaults in array', function() {

      var res = util.mergeWithSchemaDefaults(
        {foo: [{one: 3}, {two: 2}]},
        {
          type: 'object',
          properties: {
            foo: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  one: {type: 'number', 'default': 1},
                  two: {type: 'number', 'default': 2}
                }
              }
            }
          },

        }
      );

      res.should.deep.eq({foo: [{one: 3, two: 2}, {one: 1, two: 2}]});
    });

  });
});
