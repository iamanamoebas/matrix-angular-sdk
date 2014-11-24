/*
Copyright 2014 OpenMarket Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

angular.module('RoomController', ['ngSanitize', 'matrixFilter', 'mFileInput', 'angular-peity'])
.controller('RoomController', ['$modal', '$scope', '$timeout', '$routeParams', '$location', '$rootScope', 'matrixService', 'eventHandlerService', 'mFileUpload', 'MatrixCall', 'modelService', 'recentsService', 'commandsService', 'mUserDisplayNameFilter', 'dialogService',
                               function($modal, $scope, $timeout, $routeParams, $location, $rootScope, matrixService, eventHandlerService, mFileUpload, MatrixCall, modelService, recentsService, commandsService, mUserDisplayNameFilter, dialogService) {
   'use strict';
    var MESSAGES_PER_PAGINATION = 30;
    var THUMBNAIL_SIZE = 320;
    
    // .html needs this
    $scope.containsBingWord = eventHandlerService.eventContainsBingWord;

    // Room ids. Computed and resolved in onInit
    $scope.room_id = undefined;

    $scope.state = {
        user_id: matrixService.config().user_id,
        permission_denied: undefined, // If defined, this string contains the reason why the user cannot join the room
        first_pagination: true, // this is toggled off when the first pagination is done
        can_paginate: false, // this is toggled off when we are not ready yet to paginate or when we run out of items
        paginating: false, // used to avoid concurrent pagination requests pulling in dup contents
        stream_failure: undefined, // the response when the stream fails
        waiting_for_joined_event: false,  // true when the join request is pending. Back to false once the corresponding m.room.member event is received
        messages_visibility: "hidden", // In order to avoid flickering when scrolling down the message table at the page opening, delay the message table display
    };

    $scope.imageURLToSend = "";
    

    // vars and functions for updating the name
    $scope.name = {
        isEditing: false,
        newNameText: "",
        editName: function() {
            if ($scope.name.isEditing) {
                console.log("Warning: Already editing name.");
                return;
            };

            var nameEvent = $scope.room.current_room_state.state_events['m.room.name'];
            if (nameEvent) {
                $scope.name.newNameText = nameEvent.content.name;
            }
            else {
                $scope.name.newNameText = "";
            }

            // Force focus to the input
            $timeout(function() {
                angular.element('.roomNameInput').focus(); 
            }, 0);

            $scope.name.isEditing = true;
        },
        updateName: function() {
            console.log("Updating name to "+$scope.name.newNameText);
            matrixService.setName($scope.room_id, $scope.name.newNameText).then(
                function() {
                },
                function(error) {
                    dialogService.showError(error);
                }
            );

            $scope.name.isEditing = false;
        },
        cancelEdit: function() {
            $scope.name.isEditing = false;
        }
    };

    // vars and functions for updating the topic
    $scope.topic = {
        isEditing: false,
        newTopicText: "",
        editTopic: function() {
            if ($scope.topic.isEditing) {
                console.log("Warning: Already editing topic.");
                return;
            }
            var topicEvent = $scope.room.current_room_state.state_events['m.room.topic'];
            if (topicEvent) {
                $scope.topic.newTopicText = topicEvent.content.topic;
            }
            else {
                $scope.topic.newTopicText = "";
            }
            
            // Force focus to the input
            $timeout(function() {
                angular.element('.roomTopicInput').focus(); 
            }, 0);
            
            $scope.topic.isEditing = true;
        },
        updateTopic: function() {
            console.log("Updating topic to "+$scope.topic.newTopicText);
            matrixService.setTopic($scope.room_id, $scope.topic.newTopicText).then(
                function() {
                },
                function(error) {
                    dialogService.showError(error);
                }
            );

            $scope.topic.isEditing = false;
        },
        cancelEdit: function() {
            $scope.topic.isEditing = false;
        }
    };  
    
    var scrollToBottom = function(force) {
        console.log("Scrolling to bottom");
        
        // Do not autoscroll to the bottom to display the new event if the user is not at the bottom.
        // Exception: in case where the event is from the user, we want to force scroll to the bottom
        var objDiv = document.getElementById("messageTableWrapper");
        if (!objDiv) {
            console.error("No messageTableWrapper found.");
            return;
        }
        // add a 10px buffer to this check so if the message list is not *quite*
        // at the bottom it still scrolls since it basically is at the bottom.
        if ((10 + objDiv.offsetHeight + objDiv.scrollTop >= objDiv.scrollHeight) || force) {
            
            $timeout(function() {
                objDiv.scrollTop = objDiv.scrollHeight;

                // Show the message table once the first scrolldown is done 
                if ("visible" !== $scope.state.messages_visibility) {
                    $timeout(function() {
                        $scope.state.messages_visibility = "visible";
                    }, 0);
                }
            }, 0);
        }
    };

    $scope.$on(eventHandlerService.MSG_EVENT, function(ngEvent, event, isLive) {
        if (isLive && event.room_id === $scope.room_id) {
            scrollToBottom();
        }
    });
    
    $scope.$on(eventHandlerService.MEMBER_EVENT, function(ngEvent, event, isLive) {
        // if there is a live event affecting us
        if (isLive && event.room_id === $scope.room_id && event.state_key === $scope.state.user_id) {
            // if someone else changed our state..
            if (event.user_id !== $scope.state.user_id && "invite" !== event.content.membership && "join" !== event.content.membership) {    
                if ("ban" === event.content.membership) {
                    $scope.state.permission_denied = "You have been banned by " + mUserDisplayNameFilter(event.user_id);
                }
                else {
                    $scope.state.permission_denied = "You have been kicked by " + mUserDisplayNameFilter(event.user_id);
                }  
            }
            else {
                scrollToBottom();
            }
        }
    });

    $scope.memberCount = function() {
        return Object.keys($scope.room.now.members).length;
    };
    
    $scope.paginateMore = function() {
        if ($scope.state.can_paginate) {
            // console.log("Paginating more.");
            paginate(MESSAGES_PER_PAGINATION);
        }
    };

    var paginate = function(numItems) {
        //console.log("paginate " + numItems + " and first_pagination is " + $scope.state.first_pagination);
        if ($scope.state.paginating || !$scope.room_id) {
            return;
        }
        else {
            $scope.state.paginating = true;
        }
        
        console.log("paginateBackMessages from " + $scope.room.old_room_state.pagination_token + " for " + numItems);
        var originalTopRow = $("#messageTable>tbody>tr:first")[0];
        
        // Paginate events from the point in cache
        matrixService.paginateBackMessages($scope.room_id, $scope.room.old_room_state.pagination_token, numItems).then(
            function(response) {

                eventHandlerService.handleRoomMessages($scope.room_id, response.data, false, 'b');
                if (response.data.chunk.length < MESSAGES_PER_PAGINATION) {
                    // no more messages to paginate. this currently never gets turned true again, as we never
                    // expire paginated contents in the current implementation.
                    $scope.state.can_paginate = false;
                }
                
                $scope.state.paginating = false;
                
                var wrapper = $("#messageTableWrapper")[0];
                var table = $("#messageTable")[0];
                if (!wrapper || !table) {
                    console.error("Cannot find table.");
                    wrapper = null;
                    table = null;
                    return;
                }
                // console.log("wrapper height=" + wrapper.clientHeight + ", table scrollHeight=" + table.scrollHeight);
                
                if ($scope.state.can_paginate) {
                    // check we don't have to pull in more messages
                    // n.b. we dispatch through a timeout() to allow the digest to run otherwise the .height methods are stale
                    $timeout(function() {
                        if (table.scrollHeight < wrapper.clientHeight) {
                            paginate(MESSAGES_PER_PAGINATION);
                            scrollToBottom();                            
                        }
                    }, 0);
                }
                
                if ($scope.state.first_pagination) {
                    scrollToBottom(true);
                    $scope.state.first_pagination = false;
                    wrapper = null;
                    table = null;
                }
                else {
                    // lock the scroll position
                    $timeout(function() {
                        // FIXME: this risks a flicker before the scrollTop is actually updated, but we have to
                        // dispatch it into a function in order to first update the layout.  The right solution
                        // might be to implement it as a directive, more like
                        // http://stackoverflow.com/questions/23736647/how-to-retain-scroll-position-of-ng-repeat-in-angularjs
                        // however, this specific solution breaks because it measures the rows height before
                        // the contents are interpolated.
                        wrapper.scrollTop = originalTopRow ? (originalTopRow.offsetTop + wrapper.scrollTop) : 0;
                        wrapper = null;
                        table = null;
                    }, 0);
                }
            },
            function(error) {
                console.log("Failed to paginateBackMessages: " + JSON.stringify(error));
                $scope.state.paginating = false;
            }
        );
    };
    
    var presencePromise = undefined;
    var updatePresenceTimes = function() { 
        if (presencePromise === "$destroy") {
            return;
        }
        $scope.now = new Date().getTime();
        // TODO: don't bother polling every 5s if we know none of our counters are younger than 1 minute
        presencePromise = $timeout(updatePresenceTimes, 5 * 1000); 
    };
    
    $scope.$on("$destroy", function() {
        $timeout.cancel(presencePromise);
        presencePromise = "$destroy";
        $scope.room = null;
    });

    $scope.send = function() {
        var input = $('#mainInput').val();
        
        if (undefined === input || input === "") {
            return;
        }
        
        scrollToBottom(true);

        // Store the command in the history
        $rootScope.$broadcast("commandHistory:BROADCAST_NEW_HISTORY_ITEM(item)",
                              input);

        var isEmote = input.indexOf("/me ") === 0;
        var promise;
        if (!isEmote) {
            promise = commandsService.processInput($scope.room_id, input);
        }
        var echo = false;
        
        
        if (!promise) { // not a non-echoable command
            echo = true;
            if (isEmote) {
                promise = matrixService.sendEmoteMessage($scope.room_id, input.substring(4));
            }
            else {
                promise = matrixService.sendTextMessage($scope.room_id, input);
            }
        }
        
        if (echo) {
            // Echo the message to the room
            // To do so, create a minimalist fake text message event and add it to the in-memory list of room messages
            var echoMessage = {
                content: {
                    body: (isEmote ? input.substring(4) : input),
                    msgtype: (isEmote ? "m.emote" : "m.text"),
                },
                origin_server_ts: new Date().getTime(), // fake a timestamp
                room_id: $scope.room_id,
                type: "m.room.message",
                user_id: $scope.state.user_id,
                echo_msg_state: "messagePending"     // Add custom field to indicate the state of this fake message to HTML
            };

            $('#mainInput').val('');
            $scope.room.addMessageEvent(echoMessage);
            scrollToBottom();
        }

        if (promise) {
            // Reset previous feedback
            $scope.feedback = "";

            promise.then(
                function(response) {
                    console.log("Request successfully sent");

                    if (echo) {
                        // Mark this fake message event with its allocated event_id
                        // When the true message event will come from the events stream (in handleMessage),
                        // we will be able to replace the fake one by the true one
                        echoMessage.event_id = response.data.event_id;
                    }
                    else {
                        $('#mainInput').val('');
                    }         
                },
                function(error) {
                    $scope.feedback = error.data.error;

                    if (echoMessage) {
                        // Mark the message as unsent for the rest of the page life
                        echoMessage.origin_server_ts = "Unsent";
                        echoMessage.echo_msg_state = "messageUnSent";
                    }
                });
        }
    };

    // Tries to find a suitable room ID for this room.
    $scope.onInit = function() {
        console.log("onInit");

        // Extract the room identifier being loaded
        var room_id_or_alias;
        if ($routeParams.room_id_or_alias) { // provided in the url
            room_id_or_alias = decodeURIComponent($routeParams.room_id_or_alias);
        }
        
        if (!room_id_or_alias) {
            // Get the room alias by hand from the URL
            // ie: extract #public:localhost:8080 from http://127.0.0.1:8000/#/room/#public:localhost:8080
            if (3 === location.hash.split("#").length) {
                room_id_or_alias = "#" + decodeURIComponent(location.hash.split("#")[2]);
            }
            else {
                // In case of issue, go to the default page
                console.log("Error: cannot extract room alias");
                $location.url("/");
                return;
            }
        }
        
        eventHandlerService.joinRoom(room_id_or_alias).then(function(roomId) {
            $scope.room_id = roomId;
            $scope.room = modelService.getRoom($scope.room_id);
            
            var messages = $scope.room.events;

            if (0 === messages.length
            || (1 === messages.length && "m.room.member" === messages[0].type && "invite" === messages[0].content.membership && $scope.state.user_id === messages[0].state_key)) {
                // If we just joined a room, we won't have this history from initial sync, so we should try to paginate it anyway    
                $scope.state.first_pagination = true;
            }
            else {
                // There is no need to do a 1st pagination (initialSync provided enough to fill a page)
                $scope.state.first_pagination = false;
            }
            
            // Make recents highlight the current room
            recentsService.setSelectedRoomId($scope.room_id);
            
            updatePresenceTimes();

            // Allow pagination
            $scope.state.can_paginate = true;

            // Do a first pagination only if it is required (e.g. we've JUST joined a room and have no messages to display.)
            // FIXME: Should be no more require when initialSync/{room_id} will be available
            if ($scope.state.first_pagination) {
                paginate(MESSAGES_PER_PAGINATION);
            }
            
            // Scroll down as soon as possible so that we point to the last message
            // if it already exists in memory
            scrollToBottom(true);
        },
        function(err) {
            dialogService.showError(err).then(function(r){
                $location.url("/");	
            }, function(r) {
                $location.url("/");	
            });
        });
    };

    $scope.leaveRoom = function() {
        
        matrixService.leave($scope.room_id).then(
            function(response) {
                console.log("Left room " + $scope.room_id);
                $location.url("home");
            },
            function(error) {
                $scope.feedback = "Failed to leave room: " + error.data.error;
            });
    };

    // used to send an image based on just a URL, rather than uploading one
    $scope.sendImage = function(url, body) {
        scrollToBottom(true);
        
        matrixService.sendImageMessage($scope.room_id, url, body).then(
            function() {
                console.log("Image sent");
            },
            function(error) {
                $scope.feedback = "Failed to send image: " + error.data.error;
            });
    };
    
    $scope.fileToSend;
    $scope.$watch("fileToSend", function(newValue, oldValue) {
        if ($scope.fileToSend) {
            // Upload this file
            mFileUpload.uploadFileAndThumbnail($scope.fileToSend, THUMBNAIL_SIZE).then(
                function(fileMessage) {
                    // fileMessage is complete message structure, send it as is
                    matrixService.sendMessage($scope.room_id, undefined, fileMessage).then(
                        function() {
                            console.log("File message sent");
                        },
                        function(error) {
                            $scope.feedback = "Failed to send file message: " + error.data.error;
                        });
                },
                function(error) {
                    $scope.feedback = "Can't upload file";
                }
            );
        }
    });
    
    $scope.loadMoreHistory = function() {
        paginate(MESSAGES_PER_PAGINATION);
    };

    $scope.checkWebRTC = function() {
        if (!$rootScope.isWebRTCSupported()) {
            alert("Your browser does not support WebRTC");
            return false;
        }
        if ($scope.memberCount() != 2) {
            alert("WebRTC calls are currently only supported on rooms with two members");
            return false;
        }
        return true;
    };
    
    $scope.startVoiceCall = function() {        
        if (!$scope.checkWebRTC()) return;
        var call = new MatrixCall($scope.room_id);
        call.onError = $rootScope.onCallError;
        call.onHangup = $rootScope.onCallHangup;
        // remote video element is used for playing audio in voice calls
        call.remoteVideoSelector = angular.element('#remoteVideo')[0];
        call.placeVoiceCall();
        $rootScope.currentCall = call;
    };

    $scope.startVideoCall = function() {
        if (!$scope.checkWebRTC()) return;

        var call = new MatrixCall($scope.room_id);
        call.onError = $rootScope.onCallError;
        call.onHangup = $rootScope.onCallHangup;
        call.localVideoSelector = '#localVideo';
        call.remoteVideoSelector = '#remoteVideo';
        call.placeVideoCall();
        $rootScope.currentCall = call;
    };

    $scope.openJson = function(content) {
        $scope.event_selected = angular.copy(content);
        
        // FIXME: Pre-calculated event data should be stripped in a nicer way.
        $scope.event_selected.__room_member = undefined;
        $scope.event_selected.__target_room_member = undefined;
        
        // scope this so the template can check power levels and enable/disable
        // buttons
        $scope.modelService = modelService;

        var modalInstance = $modal.open({
            templateUrl: 'eventInfoTemplate.html',
            controller: 'EventInfoController',
            scope: $scope
        });

        modalInstance.result.then(function(action) {
            if (action === "redact") {
                var eventId = $scope.event_selected.event_id;
                console.log("Redacting event ID " + eventId);
                matrixService.redactEvent(
                    $scope.event_selected.room_id,
                    eventId
                ).then(function(response) {
                    console.log("Redaction = " + JSON.stringify(response));
                }, function(error) {
                    console.error("Failed to redact event: "+JSON.stringify(error));
                    if (error.data.error) {
                        $scope.feedback = error.data.error;
                    }
                });
            }
        }, function() {
            // any dismiss code
        });
    };

    $scope.openRoomInfo = function() {
        $scope.roomInfo = {};
        $scope.roomInfo.newEvent = {
            content: {},
            type: "",
            state_key: ""
        };

        var stateEvents = $scope.room.current_room_state.state_events;
        // The modal dialog will 2-way bind this field, so we MUST make a deep
        // copy of the state events else we will be *actually adjusing our view
        // of the world* when fiddling with the JSON!! Apparently parse/stringify
        // is faster than jQuery's extend when doing deep copies.
        $scope.roomInfo.stateEvents = JSON.parse(JSON.stringify(stateEvents));
        var modalInstance = $modal.open({
            templateUrl: 'roomInfoTemplate.html',
            controller: 'RoomInfoController',
            size: 'lg',
            scope: $scope
        });
    };

}])
.controller('EventInfoController', function($scope, $modalInstance, modelService) {
    console.log("Displaying modal dialog for >>>> " + JSON.stringify($scope.event_selected));
    $scope.redact = function() {
        console.log("User level = "+modelService.getUserPowerLevel($scope.room_id, $scope.state.user_id)+
                    " Redact level = "+$scope.room.current_room_state.state_events["m.room.power_levels"].content.redact);
        console.log("Redact event >> " + JSON.stringify($scope.event_selected));
        $modalInstance.close("redact");
    };
    $scope.dismiss = $modalInstance.dismiss;
})
.controller('RoomInfoController', function($scope, $modalInstance, matrixService, dialogService) {
    console.log("Displaying room info.");
    
    $scope.userIDToInvite = "";
    
    $scope.inviteUser = function() {
        
        matrixService.invite($scope.room_id, $scope.userIDToInvite).then(
            function() {
                console.log("Invited.");
                $scope.feedback = "Invite successfully sent to " + $scope.userIDToInvite;
                $scope.userIDToInvite = "";
            },
            function(reason) {
                dialogService.showError(reason);
            });
    };

    $scope.submit = function(event) {
        if (event.content) {
            console.log("submit >>> " + JSON.stringify(event.content));
            matrixService.sendStateEvent($scope.room_id, event.type, 
                event.content, event.state_key).then(function(response) {
                    $modalInstance.dismiss();
                }, function(err) {
                    dialogService.showError(err);
                }
            );
        }
    };

    $scope.dismiss = $modalInstance.dismiss;

});