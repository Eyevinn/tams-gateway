import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';

const HelloWorld = Type.String({
  description: 'Ok'
});

export interface HealthcheckOptions {
  title: string;
}

const healthcheck: FastifyPluginCallback<HealthcheckOptions> = (
  fastify,
  opts,
  next
) => {
  fastify.get<{ Reply: Static<typeof HelloWorld> }>(
    '/',
    {
      schema: {
        tags: ['Healthcheck'],
        description: 'Healthcheck',
        response: {
          200: HelloWorld
        }
      }
    },
    async (_, reply) => {
      reply.send(opts.title + ' - Ok');
    }
  );
  next();
};

export default healthcheck;
