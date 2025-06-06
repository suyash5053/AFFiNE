//
//  IntelligentsEphemeralActionController+API.swift
//  Intelligents
//
//  Created by 秋星桥 on 2025/1/15.
//

import AffineGraphQL
import Foundation
import LDSwiftEventSource

extension IntelligentsEphemeralActionController {
  func beginAction() {
    print("[*] begin ephemeral action for did \(documentID) wid \(workspaceID)")
    chatTask?.stop()
    chatTask = nil
    copilotDocumentStorage = ""
    sessionID = ""
    messageID = ""
    chat_createSession(
      documentIdentifier: documentID,
      workspaceIdentifier: workspaceID
    ) { session in
      self.sessionID = session
      self.beginThisRound()
    } onFailure: { error in
      self.presentError(error) {
        self.close()
      }
    }
  }

  func chat_createSession(
    documentIdentifier: String,
    workspaceIdentifier: String,
    onSuccess: @escaping (String) -> Void,
    onFailure: @escaping (Error) -> Void
  ) {
    if documentIdentifier.isEmpty || workspaceIdentifier.isEmpty {
      onFailure(UnableTo.identifyDocumentOrWorkspace)
    }
    Intelligents.qlClient.perform(
      mutation: CreateCopilotSessionMutation(options: .init(
        docId: documentIdentifier,
        promptName: action.prompt.rawValue,
        workspaceId: workspaceIdentifier
      )),
      queue: .global()
    ) { result in
      switch result {
      case let .success(value):
        if let session = value.data?.createCopilotSession, !session.isEmpty {
          DispatchQueue.main.async { onSuccess(session) }
        } else {
          DispatchQueue.main.async {
            onFailure(UnableTo.createSession)
          }
        }
      case let .failure(error):
        DispatchQueue.main.async { onFailure(error) }
      }
    }
  }

  func beginThisRound() {
    let parms: [String: AnyHashable] = switch action {
    case let .translate(lang):
      ["language": lang.rawValue]
    case .summarize:
      [:]
    }
    let json = try! CustomJSON(_jsonValue: parms)
    Intelligents.qlClient.perform(
      mutation: CreateCopilotMessageMutation(options: .init(
        content: .init(stringLiteral: "\(documentContent)"),
        params: .some(json),
        sessionId: sessionID
      )),
      queue: .global()
    ) { result in
      switch result {
      case let .success(value):
        if let messageID = value.data?.createCopilotMessage {
          self.messageID = messageID
          self.chat_processWithMessageID(sessionID: self.sessionID, messageID: messageID)
        } else {
          self.presentError(UnableTo.createMessage) {
            self.close()
          }
        }
      case let .failure(error):
        self.presentError(error) {
          self.close()
        }
      }
    }
  }

  func chat_processWithMessageID(sessionID: String, messageID: String) {
    let url = Constant.affineUpstreamURL
      .appendingPathComponent("api")
      .appendingPathComponent("copilot")
      .appendingPathComponent("chat")
      .appendingPathComponent(sessionID)
      .appendingPathComponent("stream")
    var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
    comps?.queryItems = [URLQueryItem(name: "messageId", value: messageID)]

    guard let url = comps?.url else {
      assertionFailure()
      presentError(UnableTo.createMessage)
      return
    }

    let eventHandler = BlockEventHandler()
    eventHandler.onOpenedBlock = {
      print("[*] chat opened")
    }
    eventHandler.onErrorBlock = { error in
      self.presentError(error) { self.close() }
    }
    eventHandler.onMessageBlock = { _, message in
      self.chat_onEvent(message.data)
    }
    eventHandler.onClosedBlock = {
      self.chatTask?.stop()
      self.chatTask = nil
    }
    let eventSource = EventSource(config: .init(handler: eventHandler, url: url))
    eventSource.start()
    chatTask = eventSource
  }

  func chat_onEvent(_ data: String) {
    if Thread.isMainThread {
      copilotDocumentStorage += data
    } else {
      DispatchQueue.main.asyncAndWait {
        self.copilotDocumentStorage += data
      }
    }
  }
}
