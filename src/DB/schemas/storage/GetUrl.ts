import { Type } from '@sinclair/typebox';

const GetUrl = Type.Object({
  url: Type.String(),
  label: Type.String()
});

export default GetUrl;
