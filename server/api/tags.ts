import { getAllTags } from '@/server/tagsListServe';

export default defineEventHandler(() => {
  return getAllTags();
});