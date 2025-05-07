import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import createS3URL from '../utils/createS3URL';
import ErrorResponse from '../utils/error-response';

const reponseType = Type.String();

const opts = {
  schema: {
    tags: ['Storage & Segments'],
    description: 'List flow segments',
    response: {
      200: reponseType
    }
  }
};

const ListSegmentsParams = Type.Object({
  bucket_id: Type.Optional(Type.String())
});

const getS3URL: FastifyPluginCallback = (fastify, _, next) => {
  fastify.get<{
    Reply: Static<typeof reponseType | typeof ErrorResponse>;
    Params: Static<typeof ListSegmentsParams>;
  }>('/s3/:bucket_id', opts, async (request, reply) => {
    const { bucket_id } = request.params;
    const URL = await createS3URL('GET', bucket_id);
    reply.code(200).send(URL);
  });
  next();
};

export default getS3URL;
