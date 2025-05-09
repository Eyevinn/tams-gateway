import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import { segmentsClient } from '../../../DB/client';
import ErrorResponse from '../../utils/error-response';
import Segment from '../../../DB/schemas/segments/Segment';
import createS3URL from '../../utils/createS3URL';

const SegmentsArray = Type.Array(Segment);

const opts = {
  schema: {
    tags: ['Storage & Segments'],
    description: 'List flow segments',
    querystring: {
      properties: {
        timerange: {
          type: 'string',
          pattern: '\\[\\d{1,2}:\\d{1,2}_\\d{1,2}:\\d{1,2}\\)'
        }
      }
    },
    response: {
      200: SegmentsArray
    }
  }
};

const ListSegmentsParams = Type.Object({
  id: Type.String()
});

const ListSegmentsQueries = Type.Object({
  timerange: Type.Optional(Type.String())
});

const getStartEndTimeInSeconds = (timerange: string) => {
  const stripedSegmentTimerange = timerange.replace('[', '').replace(')', '');
  const [startTime, endTime] = stripedSegmentTimerange.split('_');
  const [startTimeMinutes, startTimeSeconds] = startTime.split(':');
  const [endTimeMinutes, endTimeSeconds] = endTime.split(':');
  return [
    Number(startTimeMinutes) * 60 + Number(startTimeSeconds),
    Number(endTimeMinutes) * 60 + Number(endTimeSeconds)
  ];
};

// Fetch segments and filter based on timerange
const listSegments: FastifyPluginCallback = (fastify, _, next) => {
  fastify.get<{
    Reply: Static<typeof SegmentsArray | typeof ErrorResponse>;
    Params: Static<typeof ListSegmentsParams>;
    Querystring: Static<typeof ListSegmentsQueries>;
  }>('/flows/:id/segments', opts, async (request, reply) => {
    const { id } = request.params;
    const { timerange } = request.query;
    const DBSegments = await segmentsClient.get(id);
    let filteredSegments = DBSegments.segments;
    if (timerange) {
      const [timerangeStart, timerangeEnd] =
        getStartEndTimeInSeconds(timerange);
      filteredSegments = DBSegments.segments.filter((segment) => {
        const [start, end] = getStartEndTimeInSeconds(segment.timerange);
        const isInInterval =
          (start >= timerangeStart && start < timerangeEnd) ||
          (end > timerangeStart && end <= timerangeEnd);
        return isInInterval;
      });
    }
    const segments = await Promise.all(
      filteredSegments.map(async (segment) => ({
        ...segment,
        get_urls: [{ url: await createS3URL('GET', segment.object_id) }]
      }))
    );
    reply.code(200).send(segments);
  });
  next();
};

export default listSegments;
