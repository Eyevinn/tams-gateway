import { Type } from '@sinclair/typebox';
import Bucket from './Bucket';

const Pre = Type.Optional(Type.Array(Bucket));

export default Pre;
