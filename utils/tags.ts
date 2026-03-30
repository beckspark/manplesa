import eventSourcesJSON from '@/assets/event_sources.json';

export interface Tag {
  name: string;
  isVisible: boolean;
  isHidden: boolean;
  isHeader: boolean;
}

export function getAllTags(): Tag[] {
  const tagsHidden = new Set(eventSourcesJSON.appConfig.tagsHidden);
  const tagsHeader = eventSourcesJSON.appConfig.tagsHeader;
  
  return tagsHeader.map(tag => ({
    name: tag.name,
    fullName: tag.fullName,
    isVisible: tag.defaultValue === "true",
    isHidden: tagsHidden.has(tag.name),
    isHeader: false,
}));
}