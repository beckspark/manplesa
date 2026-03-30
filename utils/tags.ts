import eventSourcesJSON from '@/assets/event_sources.json';

export interface Tag {
  name: string;
  fullName?: string;
  isVisible: boolean;
  isHidden: boolean;
  isHeader: boolean;
}

function extractSourceNames(urls: string[]): string[] {
  return urls.map(url => {
    const parts = url.split('/');
    return parts[parts.length - 1];
  });
}

export function getAllTags(): Tag[] {
  const tagsSet = new Set<string>();

  // Add all tags from tagsToShow
  eventSourcesJSON.appConfig.tagsToShow.forEach(tag => {
    if (typeof tag === 'object' && tag.name) tagsSet.add(tag.name);
  });

  // Add header tags
  eventSourcesJSON.appConfig.tagsHeader.forEach(tag => {
    tagsSet.add(tag.name);
  });

  // Add tags from all event source filters
  const sourceNames = extractSourceNames(eventSourcesJSON.appConfig.eventApiToGrab);
  sourceNames.forEach(sourceName => {
    const eventSourceArray = eventSourcesJSON[sourceName];
    if (eventSourceArray) {
      eventSourceArray.forEach(source => {
        if (!source.filters) return;
        source.filters.forEach(filter => {
          if (Array.isArray(filter) && filter.length > 0) {
            const firstFilterElement = filter[0];
            if (Array.isArray(firstFilterElement)) {
              firstFilterElement.forEach(subTag => {
                if (typeof subTag === 'string') tagsSet.add(subTag);
              });
            } else if (typeof firstFilterElement === 'string') {
              tagsSet.add(firstFilterElement);
            }
          }
        });
      });
    }
  });

  const tagsHidden = new Set(eventSourcesJSON.appConfig.tagsHidden);
  const tagsHeaderMap = new Map(eventSourcesJSON.appConfig.tagsHeader.map(tag => [tag.name, tag]));
  const tagsToShowMap = new Map(eventSourcesJSON.appConfig.tagsToShow.map(tag => [tag.name, tag]));

  return Array.from(tagsSet).map(tag => {
    const headerTag = tagsHeaderMap.get(tag);
    const showTag = tagsToShowMap.get(tag);

    let defaultVisible = !tagsHidden.has(tag);
    if (headerTag && headerTag.defaultValue !== undefined) {
      defaultVisible = headerTag.defaultValue === "true";
    } else if (showTag && showTag.defaultValue !== undefined) {
      defaultVisible = showTag.defaultValue === "true";
    }

    return {
      name: tag,
      fullName: headerTag?.fullName || showTag?.fullName,
      isVisible: defaultVisible,
      isHidden: tagsHidden.has(tag),
      isHeader: tagsHeaderMap.has(tag),
    };
  });
}