import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import ErrorResponse from '../../utils/error-response';
import { Storage } from '../../../db/schemas/storage/Storage';
import { v4 as uuidv4 } from 'uuid';
import createS3URL from '../../utils/createS3URL';

const PostStorageErrorBody = Type.Intersect([
  ErrorResponse,
  Type.Object({ id: Type.String() })
]);

const PostStorageBody = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
  content_type: Type.Optional(Type.String())
});

const PostStorageReply = Storage;

const PostStorageParams = Type.Object({
  id: Type.String()
});

const opts = {
  schema: {
    tags: ['Storage & Segments'],
    description: 'Allocate media object storage and return presigned PUT URLs',
    body: PostStorageBody,
    response: {
      200: PostStorageReply
    }
  }
};

const DEFAULT_LIMIT = 1;
const DEFAULT_CONTENT_TYPE = 'video/mp2t';

// Allocate media objects in the pre-provisioned bucket (S3_BUCKET) and return
// presigned PUT URLs. The bucket must already exist; the gateway never creates
// buckets. object_id is `<bucket>/<key>` so the same value resolves to a GET
// URL when segments are listed.
const postStorage: FastifyPluginCallback = (fastify, _, next) => {
  fastify.post<{
    Body: Static<typeof PostStorageBody>;
    Reply: Static<typeof PostStorageReply | typeof PostStorageErrorBody>;
    Params: Static<typeof PostStorageParams>;
  }>('/flows/:id/storage', opts, async (request, reply) => {
    const bucket = process.env.S3_BUCKET as string;
    const limit = request.body.limit ?? DEFAULT_LIMIT;
    const contentType = request.body.content_type ?? DEFAULT_CONTENT_TYPE;

    const media_objects = [];
    for (let i = 0; i < limit; i++) {
      const object_id = `${bucket}/${uuidv4()}`;
      media_objects.push({
        object_id,
        put_url: {
          url: await createS3URL('PUT', object_id),
          'content-type': contentType
        }
      });
    }

    reply.code(200).send({ media_objects });
  });
  next();
};

export default postStorage;
