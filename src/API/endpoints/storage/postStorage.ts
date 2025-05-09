import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import ErrorResponse from '../../utils/error-response';
import { Storage } from '../../../DB/schemas/storage/Storage';
import Pre from '../../../DB/schemas/storage/Pre';
import { createBucketBody } from '../../utils/createS3URL';
import { v4 as uuidv4 } from 'uuid';
import createS3URL from '../../utils/createS3URL';

const PostStorageErrorBody = Type.Intersect([
  ErrorResponse,
  Type.Object({ id: Type.String() })
]);

const PostStorageBody = Type.Object({
  limit: Type.Optional(Type.Integer())
});

const PostStorageReply = Type.Intersect([Type.Object({ pre: Pre }), Storage]);

const PostStorageParams = Type.Object({
  id: Type.String()
});

const opts = {
  schema: {
    tags: ['Storage & Segments'],
    description: 'Create segment storage',
    body: {},
    response: {
      200: PostStorageReply
    }
  }
};

// Create signed AWS URLs to create buckets and PUT Segments to the S3 Storage
const postStorage: FastifyPluginCallback = (fastify, _, next) => {
  fastify.post<{
    Body: Static<typeof PostStorageBody>;
    Reply: Static<typeof PostStorageReply | typeof PostStorageErrorBody>;
    Params: Static<typeof PostStorageParams>;
  }>('/flows/:id/storage', opts, async (_, reply) => {
    const bucket_id = 'tams-' + uuidv4();

    // TODO: Create several buckets (based on the limit of segments?)
    const pre = [
      {
        action: 'create_bucket',
        bucket_id,
        put_url: {
          url: await createS3URL('PUT', bucket_id),
          body: createBucketBody
        }
      }
    ];

    // Number of segments per bucket
    const numberOfMediaObjects = 6;
    const media_objects = [];
    for (let i = 0; i < numberOfMediaObjects; i++) {
      const newObjectID = `${bucket_id}/${uuidv4()}`;
      media_objects.push({
        object_id: newObjectID,
        put_url: {
          url: await createS3URL('PUT', newObjectID),
          'content-type': 'video/mp2t'
        }
      });
    }

    const returnObject: Static<typeof PostStorageReply> = {
      pre,
      media_objects
    };
    reply.code(200).send(returnObject);
  });
  next();
};

export default postStorage;
