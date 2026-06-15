import { Type } from '@sinclair/typebox';

const ErrorResponse = Type.Object({
  code: Type.Number(),
  message: Type.String()
});

export default ErrorResponse;
