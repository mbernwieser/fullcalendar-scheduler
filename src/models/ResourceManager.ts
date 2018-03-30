import * as request from 'superagent'
import { assignTo, applyAll, Class, EmitterMixin, EmitterInterface, BusinessHourGenerator } from 'fullcalendar'


export default class ResourceManager extends Class {

  static resourceGuid = 1

  on: EmitterInterface['on']
  one: EmitterInterface['one']
  off: EmitterInterface['off']
  trigger: EmitterInterface['trigger']
  triggerWith: EmitterInterface['triggerWith']
  hasHandlers: EmitterInterface['hasHandlers']

  calendar: any
  topLevelResources: any // if null, indicates not fetched
  resourcesById: any
  fetchId: number = 0
  isFetchingInitiated: boolean = false
  isFetchingResolved: boolean = false
  fetchingResourcesCallbacks: any
  currentStart: any
  currentEnd: any


  constructor(calendar) {
    super()
    this.calendar = calendar
    this.initializeCache()
  }


  // Resource Data Getting
  // ------------------------------------------------------------------------------------------------------------------


  /*
  Like fetchResources, but won't refetch if already fetched.
  */
  getResources(start, end, callback) {
    const isSameRange =
      (!start && !this.currentStart) || // both nonexistent ranges?
      (start && this.currentStart && start.isSame(this.currentStart) && end.isSame(this.currentEnd))

    if (!this.isFetchingInitiated || !isSameRange) { // first time? or is range different?
      this.fetchResources(start, end, callback)
    } else {
      this.whenFetchingResolved(callback)
    }
  }


  /*
  Will always fetch, even if done previously.
  Accepts optional chrono-related params to pass on to the raw resource sources.
  */
  fetchResources(start, end, callback) {
    const currentFetchId = (this.fetchId += 1)

    this.isFetchingInitiated = true
    this.isFetchingResolved = false
    let callbacks = this.fetchingResourcesCallbacks = [ callback ]

    this.fetchResourceInputs(resourceInputs => {
      if (currentFetchId === this.fetchId) {
        this.setResources(resourceInputs)
        this.isFetchingResolved = true
        this.fetchingResourcesCallbacks = null

        applyAll(callbacks, null, [ this.topLevelResources ])
      }
    }, start, end)
  }


  whenFetchingResolved(callback) {
    if (this.isFetchingResolved) {
      callback(this.topLevelResources)
    } else {
      this.fetchingResourcesCallbacks.push(callback)
    }
  }


  /*
  Accepts optional chrono-related params to pass on to the raw resource sources.
  Calls callback when done.
  */
  fetchResourceInputs(callback, start, end) {
    const { calendar } = this
    let source = calendar.opt('resources')
    const timezone = calendar.opt('timezone')

    if (typeof source === 'string') {
      source = { url: source }
    }

    if (Array.isArray(source)) {
      callback(source)

    } else if (typeof source === 'function') {
      calendar.pushLoading()

      source((resourceInputs) => {
        calendar.popLoading()
        callback(resourceInputs)
      }, start, end, calendar.opt('timezone'))

    } else if (typeof source === 'object' && source) { // non-null object
      calendar.pushLoading()

      let requestParams = {}

      if (start && end) {
        requestParams[calendar.opt('startParam')] = start.format()
        requestParams[calendar.opt('endParam')] = end.format()

        // mimick what EventManager does
        // TODO: more DRY
        if (timezone && (timezone !== 'local')) {
          requestParams[calendar.opt('timezoneParam')] = timezone
        }
      }

      let theRequest
      if (!source.method || source.method.toUpperCase() === 'GET') {
        theRequest = request.get(source.url).query(requestParams)
      } else {
        theRequest = request(source.method, source.url).send(requestParams)
      }

      theRequest.end((error, res) => {
        let resourceInputs

        calendar.popLoading()

        if (!error) {
          if (res.body) { // parsed JSON
            resourceInputs = res.body
          } else if (res.text) {
            // if the server doesn't set Content-Type, won't be parsed as JSON. parse anyway.
            resourceInputs = JSON.parse(res.text)
          }
        }

        if (resourceInputs) {
          let callbackRes = applyAll(source.success, null, [ resourceInputs, res ])

          if (Array.isArray(callbackRes)) {
            resourceInputs = callbackRes
          }

          callback(resourceInputs)
        } else {
          applyAll(source.error, null, [ error, res ])
          callback([])
        }
      })
    } else {
      callback([])
    }
  }


  getResourceById(id) { // assumes already returned from fetch
    return this.resourcesById[id]
  }


  // assumes already completed fetch
  // does not guarantee order
  getFlatResources() {
    const result = []

    for (let id in this.resourcesById) {
      result.push(this.resourcesById[id])
    }

    return result
  }


  // Resource Adding
  // ------------------------------------------------------------------------------------------------------------------


  initializeCache() {
    this.topLevelResources = []
    this.resourcesById = {}
  }


  setResources(resourceInputs) {
    let resource
    const wasSet = Boolean(this.topLevelResources)
    this.initializeCache()

    const resources = resourceInputs.map((resourceInput) => (
      this.buildResource(resourceInput)
    ))

    const validResources = []

    for (resource of resources) {
      if (this.addResourceToIndex(resource)) {
        validResources.push(resource)
      }
    }

    for (resource of validResources) {
      this.addResourceToTree(resource)
    }

    if (wasSet) {
      this.trigger('reset', this.topLevelResources)
    } else {
      this.trigger('set', this.topLevelResources)
    }

    this.calendar.publiclyTrigger('resourcesSet', [ this.topLevelResources ])
  }


  resetCurrentResources() { // resend what we already have
    if (this.topLevelResources) {
      this.trigger('reset', this.topLevelResources)
    }
  }


  clear() {
    this.isFetchingInitiated = false
    this.topLevelResources = null
  }


  addResource(resourceInput, callback?) {
    if (this.isFetchingInitiated) {
      this.whenFetchingResolved(() => { // wait for initial batch of resources
        const resource = this.buildResource(resourceInput)
        if (this.addResourceToIndex(resource)) {
          this.addResourceToTree(resource)
          this.trigger('add', resource , this.topLevelResources)

          if (callback) {
            callback(resource)
          }
        }
      })
    }
  }


  addResourceToIndex(resource) {
    if (this.resourcesById[resource.id]) {
      return false
    } else {
      this.resourcesById[resource.id] = resource

      for (let child of resource.children) {
        this.addResourceToIndex(child)
      }

      return true
    }
  }


  addResourceToTree(resource) {
    if (!resource.parent) {
      let siblings
      const parentId = String(resource['parentId'] != null ? resource['parentId'] : '')

      if (parentId) {
        const parent = this.resourcesById[parentId]
        if (parent) {
          resource.parent = parent
          siblings = parent.children
        } else {
          return false
        }
      } else {
        siblings = this.topLevelResources
      }

      siblings.push(resource)
    }

    return true
  }


  // Resource Removing
  // ------------------------------------------------------------------------------------------------------------------


  removeResource(idOrResource) {
    const id =
      (typeof idOrResource === 'object' && idOrResource) ? // non-null object
        idOrResource.id :
        idOrResource

    if (this.isFetchingInitiated) {
      this.whenFetchingResolved(() => { // wait for initial batch of resources
        const resource = this.removeResourceFromIndex(id)

        if (resource) {
          this.removeResourceFromTree(resource)
          this.trigger('remove', resource, this.topLevelResources)
        }

        return resource
      })
    }
  }


  removeResourceFromIndex(resourceId) {
    const resource = this.resourcesById[resourceId]

    if (resource) {
      delete this.resourcesById[resourceId]

      for (let child of resource.children) {
        this.removeResourceFromIndex(child.id)
      }

      return resource
    } else {
      return false
    }
  }


  removeResourceFromTree(resource, siblings = this.topLevelResources) {

    for (let i = 0; i < siblings.length; i++) {
      const sibling = siblings[i]

      if (sibling === resource) {
        resource.parent = null
        siblings.splice(i, 1)
        return true
      }

      if (this.removeResourceFromTree(resource, sibling.children)) {
        return true
      }
    }

    return false
  }


  // Resource Data Utils
  // ------------------------------------------------------------------------------------------------------------------


  buildResource(resourceInput) {
    const resource = assignTo({}, resourceInput)
    const rawClassName = resourceInput.eventClassName

    resource.id = String(
      resourceInput.id != null ?
        resourceInput.id :
        '_fc' + (ResourceManager.resourceGuid++)
    )

    // TODO: consolidate repeat logic
    resource.eventClassName = (function() {
      if (typeof rawClassName === 'string') {
        return rawClassName.split(/\s+/)
      } else if (Array.isArray(rawClassName)) {
        return rawClassName
      } else {
        return []
      }
    })()

    if (resourceInput.businessHours) {
      resource.businessHourGenerator = new BusinessHourGenerator(resourceInput.businessHours, this.calendar)
    }

    resource.children = (resourceInput.children || []).map((childInput) => {
      const child = this.buildResource(childInput)
      child.parent = resource
      return child
    })

    return resource
  }

}

EmitterMixin.mixInto(ResourceManager)
