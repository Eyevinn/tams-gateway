import { Type } from '@sinclair/typebox';
import MediaObject from './MediaObject';
import DBProperties from '../common/DBProperties';

const Storage = Type.Object({
  media_objects: Type.Array(MediaObject)
});

const DBStorage = Type.Intersect([Storage, DBProperties]);

export { Storage, DBStorage };
